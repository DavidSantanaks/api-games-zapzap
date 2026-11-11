import { MessageConfigError, render, selectIndex, splitPlayerName, validateText } from './message.js';
import { R6_CREDIT } from './r6-message.js';

const GAME_LABELS = { lol: 'LOL', cs2: 'CS2', r6: 'R6' };
// Crédito exigido pelo provedor de dados, acrescentado ao fim do resumo do jogo.
const GAME_FOOTERS = { r6: R6_CREDIT };

// Resumo semanal: conta vitórias e derrotas de cada jogador na semana e monta uma única
// mensagem por jogo, com ranking e zoeira. O elogio é raro de propósito.

export const WEEKLY_TIME_ZONE = 'America/Sao_Paulo';
export const WEEKLY_GRACE_MS = 24 * 60 * 60 * 1000;
export const WEEKLY_MAX_PLAYERS = 20;

/** Limites das faixas. A taxa de vitória ignora empates e não é arredondada na comparação. */
export const WEEKLY_RULES = Object.freeze({
  minGames: 3,
  bagreBelow: 0.40,
  medianoBelow: 0.55,
  elogioWinrate: 0.70,
  elogioMinGames: 15,
  elogioMinKda: 3,
  // Nota do ranking (destaque e bagre): metade taxa de vitória, metade KDA (limitado a 4).
  scoreKdaCap: 4,
  // Destaque de verdade precisa de mérito: vitórias ≥ 50% com KDA ≥ 1, ou KDA ≥ 2 mesmo perdendo mais.
  // Sem isso, o primeiro vira "O menos bagre" e o último, "O maior bagre".
  destaqueMinKda: 1,
  destaqueKdaAlone: 2,
});

export const WEEKLY_BANDS = [
  { key: 'sumido', label: 'Sumido', range: 'Menos de 3 partidas' },
  { key: 'bagre', label: 'Bagre', range: 'Vitórias abaixo de 40%' },
  { key: 'mediano', label: 'Mediano', range: '40% a 54%' },
  { key: 'obrigacao', label: 'Obrigação', range: '55% ou mais, sem atingir o elogio' },
  { key: 'elogio', label: 'Elogio contido', range: '70% ou mais, 15+ partidas e KDA ≥ 3,0' },
];
const BAND_KEYS = WEEKLY_BANDS.map(band => band.key);

/**
 * Motivos do primeiro e do último do ranking. Destaque exige mérito; sem mérito, o primeiro é "O menos bagre".
 * O caso depende de vitórias ≥ 50% (empates não contam) e do KDA da semana. Cada caso tem frases ácidas próprias.
 */
export const WEEKLY_HIGHLIGHTS = [
  { key: 'destaque_completo', label: 'Destaque · completo', range: 'Vitórias ≥ 50% e KDA ≥ 1' },
  { key: 'destaque_kda', label: 'Destaque · salvo pelo KDA', range: 'Mais derrotas que vitórias, mas KDA ≥ 2' },
  { key: 'menos_bagre_carona', label: 'Menos bagre · de carona', range: 'Primeiro sem mérito: vitórias ≥ 50%, mas KDA < 1' },
  { key: 'menos_bagre_fraco', label: 'Menos bagre · semana fraca', range: 'Primeiro sem mérito: mais derrotas e KDA < 2' },
  { key: 'bagre_completo', label: 'Bagre · completo', range: 'Mais derrotas que vitórias e KDA < 1' },
  { key: 'bagre_derrotas', label: 'Bagre · só perde', range: 'Mais derrotas que vitórias, mesmo com KDA ≥ 1' },
  { key: 'bagre_carona', label: 'Bagre · de carona', range: 'Vitórias ≥ 50%, mas KDA < 1' },
  { key: 'bagre_lanterna', label: 'Bagre · lanterna', range: 'Vitórias ≥ 50% e KDA ≥ 1, só foi o pior do grupo' },
];
const HIGHLIGHT_KEYS = WEEKLY_HIGHLIGHTS.map(entry => entry.key);
const PHRASE_KEYS = [...BAND_KEYS, ...HIGHLIGHT_KEYS];
/** Faixas e motivos na ordem das abas do editor. */
export const WEEKLY_PHRASE_GROUPS = [...WEEKLY_BANDS, ...WEEKLY_HIGHLIGHTS];

export const WEEKLY_TEMPLATE_VARIABLES = [
  { key: 'jogo', label: 'Jogo', description: 'LOL, CS2 ou R6.', example: 'LOL' },
  { key: 'periodo', label: 'Período', description: 'Primeiro e último dia da semana.', example: '03/11 a 09/11' },
  { key: 'ranking', label: 'Ranking', description: 'Uma linha por jogador, montada com os modelos de linha abaixo.', example: '🥇 SeuAmigo#BR1 — 12V 5D (71%) · KDA 3,10' },
  { key: 'destaque_titulo', label: 'Título do primeiro', description: '“🏆 Destaque” quando houve mérito; senão “🥴 O menos bagre”.', example: '🏆 Destaque' },
  { key: 'destaque', label: 'Destaque', description: 'Melhor nota (vitórias + KDA) entre quem jogou pelo menos 3 partidas.', example: 'Fulano#BR1' },
  { key: 'destaque_motivo', label: 'Motivo do destaque', description: 'Frase ácida explicando por que ele foi o destaque.', example: 'Destaque pelo KDA 4,60, porque pelo placar (4V 8D) era bagre.' },
  { key: 'destaque_resumo', label: 'Números do destaque', description: 'Partidas, placar e KDA do destaque.', example: '12 partidas · 4V 8D · KDA 4,60' },
  { key: 'bagre_titulo', label: 'Título do último', description: '“🐟 Bagre da semana” quando houve destaque; senão “🐡 O maior bagre”.', example: '🐟 Bagre da semana' },
  { key: 'bagre', label: 'Bagre da semana', description: 'Pior nota entre quem jogou pelo menos 3 partidas (precisa de 2+ ativos).', example: 'Beltrano#BR1' },
  { key: 'bagre_motivo', label: 'Motivo do bagre', description: 'Frase ácida explicando por que ele foi o bagre.', example: 'Bagre completo: 3V 9D e KDA 0,60.' },
  { key: 'bagre_resumo', label: 'Números do bagre', description: 'Partidas, placar e KDA do bagre.', example: '12 partidas · 3V 9D · KDA 0,60' },
  { key: 'partidas', label: 'Partidas do grupo', description: 'Total de partidas de todos os jogadores.', example: '34' },
  { key: 'vitorias', label: 'Vitórias do grupo', description: 'Total de vitórias de todos os jogadores.', example: '20' },
  { key: 'derrotas', label: 'Derrotas do grupo', description: 'Total de derrotas de todos os jogadores.', example: '14' },
];
export const WEEKLY_LINE_VARIABLES = [
  { key: 'posicao', label: 'Posição', description: '🥇, 🥈, 🥉 e depois 4º, 5º…', example: '🥇' },
  { key: 'player', label: 'Player', description: 'Nome do jogador.', example: 'SeuAmigo#BR1' },
  { key: 'nick', label: 'Nick', description: 'Nome sem a tag.', example: 'SeuAmigo' },
  { key: 'partidas', label: 'Partidas', description: 'Partidas na semana.', example: '17' },
  { key: 'partidas_texto', label: 'Partidas por extenso', description: '“1 partida” ou “17 partidas”.', example: '17 partidas' },
  { key: 'vitorias', label: 'Vitórias', description: 'Vitórias na semana.', example: '12' },
  { key: 'derrotas', label: 'Derrotas', description: 'Derrotas na semana.', example: '5' },
  { key: 'empates', label: 'Empates', description: 'Empates na semana (CS2 e R6).', example: '0' },
  { key: 'placar', label: 'Placar', description: 'Vitórias e derrotas, como 12V 5D (empates aparecem como E).', example: '12V 5D' },
  { key: 'winrate', label: 'Taxa de vitória', description: 'Vitórias ÷ (vitórias + derrotas).', example: '71%' },
  { key: 'kda', label: 'KDA da semana', description: '(Abates + assistências) ÷ mortes, somando todas as partidas.', example: '3,10' },
  { key: 'zoeira', label: 'Zoeira', description: 'Frase da faixa do jogador.', example: 'Até que jogou direitinho... não se acostuma.' },
];
const TEMPLATE_KEYS = new Set(WEEKLY_TEMPLATE_VARIABLES.map(variable => variable.key));
const LINE_KEYS = new Set(WEEKLY_LINE_VARIABLES.map(variable => variable.key));
const TEMPLATE_BUDGETS = { jogo: 10, periodo: 20, destaque_titulo: 20, bagre_titulo: 22, destaque: 64, bagre: 64, destaque_resumo: 60, bagre_resumo: 60, partidas: 6, vitorias: 6, derrotas: 6 };
const LINE_BUDGETS = {
  posicao: 4, player: 64, nick: 64, partidas: 4, partidas_texto: 15, vitorias: 4, derrotas: 4, empates: 4,
  placar: 20, winrate: 5, kda: 12,
};

// Padrão da primeira versão (09/11/2026), mantido só para atualizar instalações que nunca editaram o resumo.
const WEEKLY_CONFIG_V1 = {
  template: [
    '📅 RESUMO SEMANAL — {{jogo}}', 'Semana de {{periodo}}', '', '{{ranking}}', '',
    '🏆 Destaque: {{destaque}}', '🐟 Bagre da semana: {{bagre}}',
  ].join('\n'),
  line: '{{posicao}} {{player}} — {{placar}} ({{winrate}}) · KDA {{kda}}\n{{zoeira}}',
  inactiveLine: '💤 {{player}} — {{partidas_texto}}\n{{zoeira}}',
  phrases: {
    sumido: [
      '{{partidas_texto}} na semana. Isso é jogador ou visita de médico?',
      '{{nick}} jogou {{partidas_texto}} e já se acha parte do elenco KKKKK',
      'Tá jogando escondido em outra conta, {{nick}}?',
      'Semana de folga. Pelo menos não perdeu ponto KKKKK',
      'O monitor procurou {{nick}} a semana inteira e achou {{partidas_texto}}.',
    ],
    bagre: [
      'Semana de doação de pontos. Obrigado pela caridade, {{nick}}.',
      '{{winrate}} de vitória. Moeda jogada pro alto tem mais consistência KKKKK',
      'O adversário agradece a semana, {{nick}}. Já pode cobrar patrocínio.',
      'Com {{derrotas}} derrotas, {{nick}} virou fornecedor oficial de vitória dos outros.',
      'Semana pra esquecer. Desinstala e instala de novo que às vezes resolve KKKKK',
      '{{placar}} e KDA {{kda}}. Nem a mãe defende essa semana.',
    ],
    mediano: [
      'Moeda jogada pro alto teria o mesmo resultado.',
      '{{placar}}: ganhou umas, perdeu outras e não convenceu ninguém.',
      'Semana de ensaio. A estreia fica pra próxima, {{nick}}.',
      '{{winrate}} de vitória. Nem a zoeira nem o elogio quiseram você.',
      'Na média. E média, aqui no grupo, não ganha print.',
    ],
    obrigacao: [
      'NÃO FEZ MAIS QUE A OBRIGAÇÃO',
      '{{winrate}} de vitória. Tá bom, mas ninguém vai fazer bolo.',
      'Ganhou mais do que perdeu. É o mínimo, {{nick}}.',
      '{{placar}} na semana. Cumpriu tabela, segue o jogo.',
      'Positivo na semana. Guarda a comemoração pro dia que for de verdade.',
    ],
    elogio: [
      'Até que jogou direitinho... não se acostuma.',
      '{{placar}} e KDA {{kda}}. Tá bom, {{nick}}, essa semana passa. Só essa.',
      'Semana boa de verdade. O grupo reconhece, mas a estátua continua fora do orçamento.',
      '{{winrate}} de vitória. Vou elogiar uma vez e negar que falei KKKKK',
      'Jogou bem a semana toda. Suspeito. Quem tava na conta, {{nick}}?',
    ],
  },
};

// Padrão da segunda versão (09/11/2026), também só para atualizar quem nunca editou.
const WEEKLY_CONFIG_V2 = {
  template: WEEKLY_CONFIG_V1.template,
  line: WEEKLY_CONFIG_V1.line,
  inactiveLine: WEEKLY_CONFIG_V1.inactiveLine,
  phrases: {
    sumido: [
      '{{partidas_texto}} na semana. Até bot de fila tem mais presença que você, {{nick}}.',
      'Sumiu igual pai que foi comprar cigarro. {{partidas_texto}} e mais nada.',
      '{{nick}} jogou {{partidas_texto}} e já quer ser chamado de veterano KKKKK',
      'Tá com medo de perder ponto ou só esqueceu a senha, {{nick}}?',
      'O monitor rodou a semana inteira atrás de {{nick}}. Achou {{partidas_texto}}. Vergonha.',
      'Semana de folga. Não perdeu ponto porque nem teve coragem de jogar.',
      'Com {{partidas_texto}} nem dá pra saber se é ruim. Mas a gente desconfia, {{nick}}.',
      '{{nick}} tá no grupo só pra assistir os outros sofrerem. Covarde.',
    ],
    bagre: [
      '{{placar}}. O time adversário já colocou {{nick}} nos agradecimentos.',
      '{{winrate}} de vitória. Se cada derrota valesse um real, {{nick}} tava rico.',
      'KDA {{kda}}. Isso não é estatística, é boletim de ocorrência.',
      'Com {{derrotas}} derrotas, {{nick}} já pode pedir patrocínio pro time inimigo.',
      'Semana tão ruim que até o matchmaking pediu desculpa pros seus aliados.',
      'Desinstala, {{nick}}. Não é zoeira, é conselho. {{placar}}.',
      '{{nick}} não jogou a semana, fez caridade: {{derrotas}} derrotas doadas.',
      'Seus aliados merecem indenização. {{placar}} e KDA {{kda}}.',
      'Se o monitor estivesse desligado, ninguém precisava saber dessa vergonha, {{nick}}.',
    ],
    mediano: [
      '{{placar}}. Nem ruim o bastante pra virar meme, nem bom o bastante pra alguém lembrar.',
      '{{winrate}} de vitória. Uma moeda jogada pro alto faz isso sem precisar de internet.',
      'Peso morto educado: {{nick}} não ganha jogo, só acompanha.',
      'Semana de figurante. O time ganhou ou perdeu e {{nick}} só estava lá.',
      'Na média. E na média mora quem nunca vai sair do rank atual, {{nick}}.',
      '{{placar}}: não carrega ninguém e ainda reclama do time.',
      'Nem a zoeira nem o elogio quiseram {{nick}}. Ficou com a indiferença.',
    ],
    obrigacao: [
      'NÃO FEZ MAIS QUE A OBRIGAÇÃO.',
      '{{winrate}} de vitória. Parabéns por fazer o mínimo, quer troféu de participação?',
      'Ganhou mais do que perdeu. Isso se chama jogar, {{nick}}, não é conquista.',
      '{{placar}}. Positivo, mas todo mundo sabe que foi o time que carregou.',
      'Semana razoável. Guarda o print pra quando fizer algo de verdade, {{nick}}.',
      'Ficou acima da média e já tá se achando. Desce daí, {{nick}}.',
      'KDA {{kda}}. Bonitinho, mas ninguém do grupo vai lembrar disso amanhã.',
    ],
    elogio: [
      'Tá, {{nick}}, foi bom: {{placar}} e KDA {{kda}}. Aproveita, que não vai se repetir.',
      'Semana absurda. Quem tava jogando na sua conta, {{nick}}? Pode falar.',
      '{{winrate}} de vitória. Vou elogiar uma vez e negar até a morte.',
      'Jogou muito. Agora volta pro normal antes que alguém se acostume.',
      'Respeito, {{nick}}. Só não manda print no grupo, que aí perde a graça.',
      'Semana de smurf. Suspeito, mas os números não mentem: {{placar}}.',
    ],
  },
};

const HIGHLIGHT_PHRASES = {
  destaque_completo: [
    'Ganhou mais do que perdeu e ainda teve KDA {{kda}}. Não se acostuma, {{nick}}, foi alinhamento dos astros.',
    '{{placar}} com KDA {{kda}}. Foi o melhor de um grupo fraco, o que não é bem um elogio.',
    'Destaque por fazer o básico direito: {{placar}}. O nível aqui tá tão baixo que isso virou troféu.',
    'KDA {{kda}} e {{winrate}} de vitória. Parabéns, {{nick}}: caolho em terra de cego.',
    'Destaque da semana. Aproveita o print, que semana que vem o grupo volta a te carregar.',
  ],
  destaque_kda: [
    'Destaque pelo KDA {{kda}}, porque pelo placar ({{placar}}) era bagre. Matou todo mundo e perdeu mesmo assim.',
    '{{derrotas}} derrotas e ainda é o destaque. KDA {{kda}} de quem joga bonito pra perder bonito.',
    'Carregou o time nas costas direitinho... até a derrota. {{placar}} com KDA {{kda}}.',
    'Estatística de pro player, resultado de quem nem devia estar no rank: {{placar}}. Destaque por pena, {{nick}}.',
    'KDA {{kda}} e {{winrate}} de vitória. Farmou kill enquanto a partida ia embora.',
    'O grupo tá numa fase tão vergonhosa que o destaque perdeu {{derrotas}} de {{partidas}}. KDA {{kda}} não paga essa conta.',
  ],
  menos_bagre_carona: [
    'Não ganhou destaque, ganhou carona: {{placar}} com KDA {{kda}}. O time te arrastou até o topo, {{nick}}.',
    '{{vitorias}} vitórias morrendo mais do que matando. Isso não é carry, é carona.',
    'O placar diz primeiro lugar, o KDA {{kda}} diz passageiro. Pagou a passagem pelo menos, {{nick}}?',
    'Primeiro do ranking com KDA {{kda}}. Destaque não, só o bagre que teve mais sorte no matchmaking.',
  ],
  menos_bagre_fraco: [
    'Ninguém mereceu destaque. {{nick}} só foi o menos bagre: {{placar}} e KDA {{kda}}.',
    'Medalha de lata pro {{nick}}. Nem ele merecia, mas os outros mereciam menos.',
    'Com {{placar}} e KDA {{kda}}, ser primeiro aqui é ganhar concurso de quem caiu menos da escada.',
    'Semana tão vergonhosa que o melhor do grupo fez {{placar}}. Destaque fica guardado pra quando alguém jogar.',
  ],
  bagre_completo: [
    'Bagre completo: {{placar}} e KDA {{kda}}. Perdeu e ainda deu kill de graça pro inimigo.',
    '{{derrotas}} derrotas e KDA {{kda}}. Não jogou a semana, fez estágio no time adversário.',
    'Nem o KDA salvou: {{kda}}. {{nick}} é peso morto com conexão de internet.',
    'Perdeu, morreu, perdeu de novo. {{placar}}. Desinstala com carinho, {{nick}}.',
  ],
  bagre_derrotas: [
    'KDA {{kda}} até bonitinho, mas {{placar}}. Matou muito e não ganhou nada, igual figurante de filme de ação.',
    'Estatística pra print, placar pra vergonha: {{placar}}. Bagre com KDA de influencer.',
    '{{derrotas}} derrotas com KDA {{kda}}. Joga pra si, perde pro time. Clássico.',
    'Bagre pelo resultado: {{winrate}} de vitória. O KDA {{kda}} não paga a conta, {{nick}}.',
  ],
  bagre_carona: [
    'Ganhou {{vitorias}}, mas com KDA {{kda}}. Pegou carona no time e ainda quer dividir o prêmio.',
    'O placar ({{placar}}) engana, o KDA {{kda}} não. Foi carregado a semana inteira, {{nick}}.',
    'Bagre de mochila: a vitória é dos outros, a morte é sua. KDA {{kda}}.',
    '{{placar}} com KDA {{kda}}. Se o time soubesse quem tava atrapalhando, ganhava ainda mais.',
  ],
  bagre_lanterna: [
    'Último de uma semana boa. Bagre por comparação, mas bagre mesmo assim, {{nick}}.',
    '{{placar}} e KDA {{kda}}. Em grupo normal passava, aqui ficou na lanterna.',
    'Bagre técnico: nem foi tão mal, só foi pior que todo mundo. {{placar}}.',
    'O grupo jogou bem e {{nick}} só acompanhou. Lanterna com {{winrate}} de vitória.',
  ],
};

const DEFAULT_WEEKLY_CONFIG = {
  template: [
    '📅 RESUMO SEMANAL — {{jogo}}', 'Semana de {{periodo}}',
    '🎮 Grupo: {{partidas}} partidas · {{vitorias}}V {{derrotas}}D', '',
    '{{ranking}}', '',
    '{{destaque_titulo}}: {{destaque}} ({{destaque_resumo}})', '{{destaque_motivo}}', '',
    '{{bagre_titulo}}: {{bagre}} ({{bagre_resumo}})', '{{bagre_motivo}}',
  ].join('\n'),
  line: '{{posicao}} {{player}} — {{partidas_texto}} · {{placar}} ({{winrate}}) · KDA {{kda}}\n{{zoeira}}',
  inactiveLine: WEEKLY_CONFIG_V1.inactiveLine,
  phrases: { ...WEEKLY_CONFIG_V2.phrases, ...HIGHLIGHT_PHRASES },
};

export const getDefaultWeeklyConfig = () => structuredClone(DEFAULT_WEEKLY_CONFIG);
/** Verdadeiro quando a configuração salva é um padrão antigo nunca editado pelo usuário. */
export const isLegacyWeeklyConfig = config => [WEEKLY_CONFIG_V1, WEEKLY_CONFIG_V2]
  .some(legacy => JSON.stringify(config) === JSON.stringify(legacy));
/**
 * Atualização aditiva do resumo salvo: padrão antigo nunca editado vira o atual; configuração editada
 * ganha só as frases que faltam (motivos de destaque/bagre), sem mexer nos textos do usuário.
 */
export function upgradeWeeklyConfig(config) {
  if (isLegacyWeeklyConfig(config)) return getDefaultWeeklyConfig();
  if (!record(config) || !record(config.phrases)) return config;
  const missing = PHRASE_KEYS.filter(key => !Object.hasOwn(config.phrases, key));
  if (!missing.length) return config;
  const defaults = getDefaultWeeklyConfig().phrases;
  return { ...config, phrases: { ...config.phrases, ...Object.fromEntries(missing.map(key => [key, defaults[key]])) } };
}

// ---------------------------------------------------------------------------
// Datas no fuso de São Paulo

const partsFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: WEEKLY_TIME_ZONE, hourCycle: 'h23', weekday: 'short',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function localParts(ms) {
  const parts = Object.fromEntries(partsFormat.formatToParts(new Date(ms)).map(part => [part.type, part.value]));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday],
  };
}
function offsetAt(ms) {
  const p = localParts(ms);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}
/** Converte um horário local de São Paulo (aceita dia fora do mês, ex.: dia 0) para epoch em ms. */
function localToUtc(year, month, day, hour = 0) {
  const naive = Date.UTC(year, month - 1, day, hour);
  let result = naive - offsetAt(naive);
  const corrected = offsetAt(result);
  if (naive - corrected !== result) result = naive - corrected;
  return result;
}
const pad = value => String(value).padStart(2, '0');
function shiftedDate(year, month, day, deltaDays) {
  const date = new Date(Date.UTC(year, month - 1, day + deltaDays));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

export function normalizeWeeklySchedule({ weeklyDay = 0, weeklyHour = 21 } = {}) {
  return {
    day: Number.isInteger(weeklyDay) && weeklyDay >= 0 && weeklyDay <= 6 ? weeklyDay : 0,
    hour: Number.isInteger(weeklyHour) && weeklyHour >= 0 && weeklyHour <= 23 ? weeklyHour : 21,
  };
}

/**
 * Semana que terminou no último horário agendado (no passado ou exatamente agora).
 * As semanas são contíguas: cada uma vai do agendamento anterior (exclusivo) até este (inclusivo).
 */
export function lastWeeklyWindow(now, schedule) {
  const { day, hour } = normalizeWeeklySchedule(schedule);
  const local = localParts(now);
  let back = (local.weekday - day + 7) % 7;
  let endDate = shiftedDate(local.year, local.month, local.day, -back);
  let end = localToUtc(endDate.year, endDate.month, endDate.day, hour);
  if (end > now) {
    back += 7;
    endDate = shiftedDate(local.year, local.month, local.day, -back);
    end = localToUtc(endDate.year, endDate.month, endDate.day, hour);
  }
  return windowEndingOn(endDate, hour);
}
function windowEndingOn(endDate, hour) {
  const startDate = shiftedDate(endDate.year, endDate.month, endDate.day, -7);
  const labelStart = shiftedDate(endDate.year, endDate.month, endDate.day, -6);
  return {
    key: `${endDate.year}-${pad(endDate.month)}-${pad(endDate.day)}`,
    start: localToUtc(startDate.year, startDate.month, startDate.day, hour),
    end: localToUtc(endDate.year, endDate.month, endDate.day, hour),
    period: `${pad(labelStart.day)}/${pad(labelStart.month)} a ${pad(endDate.day)}/${pad(endDate.month)}`,
  };
}
/** Semana em andamento: começa no último agendamento e termina no próximo. */
export function currentWeeklyWindow(now, schedule) {
  const last = lastWeeklyWindow(now, schedule);
  const { hour } = normalizeWeeklySchedule(schedule);
  const [year, month, day] = last.key.split('-').map(Number);
  return windowEndingOn(shiftedDate(year, month, day, 7), hour);
}
/** Semana cujo resumo deve ser gerado agora, ou null fora da tolerância de 24 horas após o horário. */
export function dueWeeklyWindow(now, schedule, graceMs = WEEKLY_GRACE_MS) {
  const window = lastWeeklyWindow(now, schedule);
  return now - window.end < graceMs ? window : null;
}

// ---------------------------------------------------------------------------
// Cálculo

const integer = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
};
const resultOf = match => {
  if (match.result === 'draw') return 'draw';
  if (match.result === 'win' || match.win === true) return 'win';
  return 'loss';
};
export function playerDisplayName(player) {
  if ((player.game || 'lol') === 'lol' && player.gameName && player.tagLine) return `${player.gameName}#${player.tagLine}`;
  return String(player.gameName || player.steamId || 'Jogador');
}

/** Estatísticas da semana de cada jogador ativo, inclusive quem não jogou. */
export function summarizeWeek(players, matches) {
  return players.map(player => {
    const own = matches.filter(match => match.playerId === player.id)
      .sort((a, b) => String(a.endedAt).localeCompare(String(b.endedAt)));
    const stats = { wins: 0, losses: 0, draws: 0, kills: 0, deaths: 0, assists: 0 };
    for (const match of own) {
      stats[{ win: 'wins', loss: 'losses', draw: 'draws' }[resultOf(match)]] += 1;
      stats.kills += integer(match.kills);
      stats.deaths += integer(match.deaths);
      stats.assists += integer(match.assists);
    }
    const decisive = stats.wins + stats.losses;
    return {
      playerId: player.id,
      name: own.at(-1)?.playerName || playerDisplayName(player),
      games: own.length,
      ...stats,
      winrate: decisive ? stats.wins / decisive : null,
      kda: (stats.kills + stats.assists) / Math.max(1, stats.deaths),
    };
  });
}

export function classifyWeek(stats) {
  if (stats.games < WEEKLY_RULES.minGames) return 'sumido';
  if (stats.winrate === null) return 'mediano';
  if (stats.winrate < WEEKLY_RULES.bagreBelow) return 'bagre';
  if (stats.winrate < WEEKLY_RULES.medianoBelow) return 'mediano';
  if (stats.winrate >= WEEKLY_RULES.elogioWinrate && stats.games >= WEEKLY_RULES.elogioMinGames
    && stats.kda >= WEEKLY_RULES.elogioMinKda) return 'elogio';
  return 'obrigacao';
}

/** Nota da semana (0 a 1): metade taxa de vitória, metade KDA limitado a 4. Só empates contam como 50%. */
export function weeklyScore(stats) {
  const winrate = stats.winrate ?? 0.5;
  return winrate / 2 + Math.min(stats.kda, WEEKLY_RULES.scoreKdaCap) / WEEKLY_RULES.scoreKdaCap / 2;
}
/** Motivo do primeiro (destaque com mérito ou menos bagre) e do último do ranking. */
export function highlightReason(stats, kind) {
  const winning = (stats.winrate ?? 0.5) >= 0.5;
  const kdaOk = stats.kda >= 1;
  if (kind === 'destaque') {
    if (winning && stats.kda >= WEEKLY_RULES.destaqueMinKda) return 'destaque_completo';
    if (!winning && stats.kda >= WEEKLY_RULES.destaqueKdaAlone) return 'destaque_kda';
    return winning ? 'menos_bagre_carona' : 'menos_bagre_fraco';
  }
  if (winning) return kdaOk ? 'bagre_lanterna' : 'bagre_carona';
  return kdaOk ? 'bagre_derrotas' : 'bagre_completo';
}

/** O primeiro só é "destaque" com mérito; sem ele, os títulos viram "O menos bagre" e "O maior bagre". */
export const isRealHighlight = reason => reason === 'destaque_completo' || reason === 'destaque_kda';
export const WEEKLY_TITLES = {
  destaque: '🏆 Destaque', menos_bagre: '🥴 O menos bagre', bagre: '🐟 Bagre da semana', maior_bagre: '🐡 O maior bagre',
};

/**
 * Classificação da semana guardada na plataforma (não é enviada): posição, faixa, nota e título de cada
 * jogador, inclusive de quem sumiu. Retorna null quando ninguém jogou.
 */
export function weeklyStandings(summaries) {
  if (!summaries.some(stats => stats.games > 0)) return null;
  const { active, inactive } = rankWeek(summaries.slice(0, WEEKLY_MAX_PLAYERS));
  const topReason = active[0] ? highlightReason(active[0], 'destaque') : null;
  const merit = isRealHighlight(topReason);
  const bottom = active.length >= 2 ? active.at(-1) : null;
  const titleOf = stats => {
    if (stats === active[0]) return merit ? 'destaque' : 'menos_bagre';
    if (stats === bottom) return merit ? 'bagre' : 'maior_bagre';
    return null;
  };
  return {
    merit,
    players: [...active, ...inactive].map((stats, index) => ({
      playerId: stats.playerId, name: stats.name, position: index + 1, band: stats.band, title: titleOf(stats),
      reason: stats === active[0] ? topReason : stats === bottom ? highlightReason(stats, 'bagre') : null,
      score: stats.band === 'sumido' ? null : Math.round(stats.score * 1000) / 1000,
      games: stats.games, wins: stats.wins, losses: stats.losses, draws: stats.draws,
      kills: stats.kills, deaths: stats.deaths, assists: stats.assists,
    })),
  };
}

/** Ranking histórico por jogador, somando as semanas guardadas: quantas vezes foi destaque, bagre etc. */
export function weeklyHall(standings) {
  const byPlayer = new Map();
  for (const week of standings) {
    for (const entry of week.players || []) {
      const row = byPlayer.get(entry.playerId) || {
        playerId: entry.playerId, name: entry.name, weeks: 0, played: 0,
        destaque: 0, menos_bagre: 0, bagre: 0, maior_bagre: 0, sumido: 0, elogio: 0,
        games: 0, wins: 0, losses: 0, draws: 0, kills: 0, deaths: 0, assists: 0, lastWeek: '',
      };
      if (String(week.weekKey) >= row.lastWeek) { row.name = entry.name; row.lastWeek = String(week.weekKey); }
      row.weeks += 1;
      if (entry.band === 'sumido') row.sumido += 1; else row.played += 1;
      if (entry.band === 'elogio') row.elogio += 1;
      if (entry.title) row[entry.title] += 1;
      for (const key of ['games', 'wins', 'losses', 'draws', 'kills', 'deaths', 'assists']) row[key] += Number(entry[key]) || 0;
      byPlayer.set(entry.playerId, row);
    }
  }
  return [...byPlayer.values()].map(({ lastWeek, ...row }) => ({
    ...row, kda: (row.kills + row.assists) / Math.max(1, row.deaths),
    winrate: row.wins + row.losses ? row.wins / (row.wins + row.losses) : null,
  })).sort((a, b) => b.destaque - a.destaque || a.bagre + a.maior_bagre - (b.bagre + b.maior_bagre)
    || b.wins - a.wins || a.name.localeCompare(b.name));
}

function rankWeek(summaries) {
  const rated = summaries.map(stats => ({ ...stats, band: classifyWeek(stats), score: weeklyScore(stats) }));
  const active = rated.filter(stats => stats.band !== 'sumido').sort((a, b) =>
    b.score - a.score || b.games - a.games || b.wins - a.wins || a.name.localeCompare(b.name));
  const inactive = rated.filter(stats => stats.band === 'sumido')
    .sort((a, b) => b.games - a.games || a.name.localeCompare(b.name));
  return { active, inactive };
}

// ---------------------------------------------------------------------------
// Configuração e mensagem

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function estimatedLength(text, budgets) {
  let length = text.length;
  for (const token of text.matchAll(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g)) length += (budgets[token[1]] ?? 0) - token[0].length;
  return length;
}

export function validateWeeklyConfig(config) {
  if (!record(config)) throw new MessageConfigError('A configuração do resumo semanal deve ser um objeto.');
  const expected = ['template', 'line', 'inactiveLine', 'phrases'];
  const keys = Object.keys(config);
  if (keys.length !== expected.length || keys.some(key => !expected.includes(key))) {
    throw new MessageConfigError('A configuração do resumo semanal tem campos ausentes ou não permitidos.');
  }
  const template = validateText(config.template, { label: 'O modelo do resumo', max: 3000 }, TEMPLATE_KEYS);
  if (!/\{\{\s*ranking\s*\}\}/.test(template)) throw new MessageConfigError('O modelo do resumo precisa conter {{ranking}}.');
  const line = validateText(config.line, { label: 'A linha de quem jogou', max: 500 }, LINE_KEYS);
  const inactiveLine = validateText(config.inactiveLine, { label: 'A linha de quem sumiu', max: 500 }, LINE_KEYS);
  if (!record(config.phrases)) throw new MessageConfigError('As frases do resumo semanal devem ser um objeto.');
  const phraseKeys = Object.keys(config.phrases);
  if (phraseKeys.length !== PHRASE_KEYS.length || phraseKeys.some(key => !PHRASE_KEYS.includes(key))) {
    throw new MessageConfigError('As faixas do resumo semanal têm campos ausentes ou não permitidos.');
  }
  const phrases = {};
  for (const band of PHRASE_KEYS) {
    const pool = config.phrases[band];
    const label = WEEKLY_PHRASE_GROUPS.find(entry => entry.key === band).label;
    if (!Array.isArray(pool) || pool.length < 1 || pool.length > 30) {
      throw new MessageConfigError(`A faixa ${label} deve ter entre 1 e 30 frases.`);
    }
    phrases[band] = pool.map((phrase, index) => validateText(phrase, {
      label: `A frase ${index + 1} da faixa ${label}`, max: 300, phrase: true,
    }, LINE_KEYS).trim());
  }
  // Pior caso: 20 jogadores com nomes longos e as frases mais longas.
  const zoeira = Math.max(...BAND_KEYS.flatMap(key => phrases[key]).map(phrase => estimatedLength(phrase, LINE_BUDGETS)));
  const motivo = Math.max(...HIGHLIGHT_KEYS.flatMap(key => phrases[key]).map(phrase => estimatedLength(phrase, LINE_BUDGETS)));
  const lineLength = Math.max(
    estimatedLength(line, { ...LINE_BUDGETS, zoeira }), estimatedLength(inactiveLine, { ...LINE_BUDGETS, zoeira }));
  const ranking = WEEKLY_MAX_PLAYERS * (lineLength + 2);
  if (estimatedLength(template, { ...TEMPLATE_BUDGETS, ranking, destaque_motivo: motivo, bagre_motivo: motivo }) > 10000) {
    throw new MessageConfigError('O resumo semanal pode ultrapassar 10.000 caracteres com 20 jogadores. Encurte o modelo, as linhas ou as frases.');
  }
  return { template, line, inactiveLine, phrases };
}

const pct = value => (value === null ? '—' : `${Math.round(value * 100)}%`);
const decimal = value => value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function lineValues(stats, position) {
  const { nick } = splitPlayerName(stats.name);
  return {
    posicao: ['🥇', '🥈', '🥉'][position] || `${position + 1}º`,
    player: stats.name, nick,
    partidas: String(stats.games),
    partidas_texto: `${stats.games} ${stats.games === 1 ? 'partida' : 'partidas'}`,
    vitorias: String(stats.wins), derrotas: String(stats.losses), empates: String(stats.draws),
    placar: `${stats.wins}V ${stats.losses}D${stats.draws ? ` ${stats.draws}E` : ''}`,
    winrate: pct(stats.winrate), kda: decimal(stats.kda),
  };
}

/**
 * Monta o resumo de um jogo. Retorna null quando ninguém jogou na semana (nada é enviado).
 * `seed` deixa a escolha das frases estável para a mesma semana.
 */
export function renderWeeklyReport({ game, summaries, period, seed, config }) {
  const selected = validateWeeklyConfig(config === undefined ? getDefaultWeeklyConfig() : config);
  const totalGames = summaries.reduce((sum, stats) => sum + stats.games, 0);
  if (!totalGames) return null;
  const { active, inactive } = rankWeek(summaries.slice(0, WEEKLY_MAX_PLAYERS));
  const players = [];
  const lines = [...active, ...inactive].map((stats, index) => {
    const values = lineValues(stats, index);
    const pool = selected.phrases[stats.band];
    values.zoeira = render(pool[selectIndex(`semana:${seed}:${game}:${stats.playerId}:${stats.band}`, pool.length)], values);
    players.push({ ...stats, position: index + 1, zoeira: values.zoeira });
    return render(stats.band === 'sumido' ? selected.inactiveLine : selected.line, values);
  });
  const footer = GAME_FOOTERS[game] ? `\n\n${GAME_FOOTERS[game]}` : '';
  // Destaque e bagre saem da nota (vitórias + KDA); o motivo é uma frase ácida do caso de cada um.
  const highlight = (stats, kind) => {
    if (!stats) return { motivo: '', resumo: '—', reason: null };
    const reason = highlightReason(stats, kind);
    const pool = selected.phrases[reason];
    const values = lineValues(stats, 0);
    return {
      reason,
      motivo: render(pool[selectIndex(`semana:${seed}:${game}:${stats.playerId}:${reason}`, pool.length)], values),
      resumo: `${values.partidas_texto} · ${values.placar} · KDA ${values.kda}`,
    };
  };
  const top = highlight(active[0], 'destaque');
  const bottom = highlight(active.length >= 2 ? active.at(-1) : null, 'bagre');
  const merit = isRealHighlight(top.reason);
  const body = render(selected.template, {
    jogo: GAME_LABELS[game] || 'LOL',
    periodo: period,
    ranking: lines.join('\n\n'),
    destaque_titulo: merit || !active[0] ? WEEKLY_TITLES.destaque : WEEKLY_TITLES.menos_bagre,
    bagre_titulo: merit || !active[0] ? WEEKLY_TITLES.bagre : WEEKLY_TITLES.maior_bagre,
    destaque: active[0]?.name || '—',
    destaque_motivo: top.motivo,
    destaque_resumo: top.resumo,
    bagre: active.length >= 2 ? active.at(-1).name : '—',
    bagre_motivo: bottom.motivo,
    bagre_resumo: bottom.resumo,
    partidas: String(totalGames),
    vitorias: String(summaries.reduce((sum, stats) => sum + stats.wins, 0)),
    derrotas: String(summaries.reduce((sum, stats) => sum + stats.losses, 0)),
  });
  // Sem bagre (só um ativo), a linha do motivo fica vazia: some com as linhas em branco que sobram.
  const message = body.replace(/\(—\)/g, '').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim() + footer;
  if (message.length > 10000) throw new MessageConfigError('O resumo semanal excede 10.000 caracteres. Encurte o modelo ou as frases.');
  return {
    message, players,
    highlight: active[0] ? { playerId: active[0].playerId, reason: top.reason, title: merit ? 'destaque' : 'menos_bagre' } : null,
    bagre: active.length >= 2 ? { playerId: active.at(-1).playerId, reason: bottom.reason, title: merit ? 'bagre' : 'maior_bagre' } : null,
  };
}

/** Dados fictícios para a prévia quando ainda não há partidas na semana. */
export function exampleWeekSummaries(game) {
  const names = game === 'cs2' || game === 'r6'
    ? ['SeuAmigo', 'Fulano', 'Ciclano', 'Beltrano', 'Sicrano']
    : ['SeuAmigo#BR1', 'Fulano#BR1', 'Ciclano#BR1', 'Beltrano#BR1', 'Sicrano#BR1'];
  // Fulano perde mais do que ganha mas tem KDA alto (destaque pelo KDA); SeuAmigo ganha carregado.
  const rows = [
    [9, 3, 0, 40, 60, 11], [4, 8, 0, 150, 40, 34], [6, 6, 0, 80, 75, 25], [3, 9, 0, 30, 90, 24], [1, 0, 0, 9, 4, 3],
  ];
  return rows.map(([wins, losses, draws, kills, deaths, assists], index) => {
    const decisive = wins + losses;
    return {
      playerId: `exemplo-${index}`, name: names[index], games: wins + losses + draws, wins, losses, draws,
      kills, deaths, assists, winrate: decisive ? wins / decisive : null, kda: (kills + assists) / Math.max(1, deaths),
    };
  });
}
export const WEEKLY_CONFIG_V1_FOR_TESTS = structuredClone(WEEKLY_CONFIG_V1);
export const WEEKLY_CONFIG_V2_FOR_TESTS = structuredClone(WEEKLY_CONFIG_V2);
