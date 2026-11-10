import { MessageConfigError, render, selectIndex, splitPlayerName, validateText } from './message.js';

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
});

export const WEEKLY_BANDS = [
  { key: 'sumido', label: 'Sumido', range: 'Menos de 3 partidas' },
  { key: 'bagre', label: 'Bagre', range: 'Vitórias abaixo de 40%' },
  { key: 'mediano', label: 'Mediano', range: '40% a 54%' },
  { key: 'obrigacao', label: 'Obrigação', range: '55% ou mais, sem atingir o elogio' },
  { key: 'elogio', label: 'Elogio contido', range: '70% ou mais, 15+ partidas e KDA ≥ 3,0' },
];
const BAND_KEYS = WEEKLY_BANDS.map(band => band.key);

export const WEEKLY_TEMPLATE_VARIABLES = [
  { key: 'jogo', label: 'Jogo', description: 'LOL ou CS2.', example: 'LOL' },
  { key: 'periodo', label: 'Período', description: 'Primeiro e último dia da semana.', example: '03/11 a 09/11' },
  { key: 'ranking', label: 'Ranking', description: 'Uma linha por jogador, montada com os modelos de linha abaixo.', example: '🥇 SeuAmigo#BR1 — 12V 5D (71%) · KDA 3,10' },
  { key: 'destaque', label: 'Destaque', description: 'Primeiro colocado entre quem jogou pelo menos 3 partidas.', example: 'SeuAmigo#BR1' },
  { key: 'bagre', label: 'Bagre da semana', description: 'Último colocado entre quem jogou pelo menos 3 partidas.', example: 'Fulano#BR1' },
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
  { key: 'empates', label: 'Empates', description: 'Empates na semana (CS2).', example: '0' },
  { key: 'placar', label: 'Placar', description: 'Vitórias e derrotas, como 12V 5D (empates aparecem como E).', example: '12V 5D' },
  { key: 'winrate', label: 'Taxa de vitória', description: 'Vitórias ÷ (vitórias + derrotas).', example: '71%' },
  { key: 'kda', label: 'KDA da semana', description: '(Abates + assistências) ÷ mortes, somando todas as partidas.', example: '3,10' },
  { key: 'zoeira', label: 'Zoeira', description: 'Frase da faixa do jogador.', example: 'Até que jogou direitinho... não se acostuma.' },
];
const TEMPLATE_KEYS = new Set(WEEKLY_TEMPLATE_VARIABLES.map(variable => variable.key));
const LINE_KEYS = new Set(WEEKLY_LINE_VARIABLES.map(variable => variable.key));
const TEMPLATE_BUDGETS = { jogo: 10, periodo: 20, destaque: 64, bagre: 64, partidas: 6, vitorias: 6, derrotas: 6 };
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

const DEFAULT_WEEKLY_CONFIG = {
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

export const getDefaultWeeklyConfig = () => structuredClone(DEFAULT_WEEKLY_CONFIG);
/** Verdadeiro quando a configuração salva é um padrão antigo nunca editado pelo usuário. */
export const isLegacyWeeklyConfig = config => JSON.stringify(config) === JSON.stringify(WEEKLY_CONFIG_V1);

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

function rankWeek(summaries) {
  const rated = summaries.map(stats => ({ ...stats, band: classifyWeek(stats) }));
  const active = rated.filter(stats => stats.band !== 'sumido').sort((a, b) =>
    (b.winrate ?? 0.5) - (a.winrate ?? 0.5) || b.wins - a.wins || b.kda - a.kda || a.name.localeCompare(b.name));
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
  if (phraseKeys.length !== BAND_KEYS.length || phraseKeys.some(key => !BAND_KEYS.includes(key))) {
    throw new MessageConfigError('As faixas do resumo semanal têm campos ausentes ou não permitidos.');
  }
  const phrases = {};
  for (const band of BAND_KEYS) {
    const pool = config.phrases[band];
    const label = WEEKLY_BANDS.find(entry => entry.key === band).label;
    if (!Array.isArray(pool) || pool.length < 1 || pool.length > 30) {
      throw new MessageConfigError(`A faixa ${label} deve ter entre 1 e 30 frases.`);
    }
    phrases[band] = pool.map((phrase, index) => validateText(phrase, {
      label: `A frase ${index + 1} da faixa ${label}`, max: 300, phrase: true,
    }, LINE_KEYS).trim());
  }
  // Pior caso: 20 jogadores com nomes longos e as frases mais longas.
  const zoeira = Math.max(...Object.values(phrases).flat().map(phrase => estimatedLength(phrase, LINE_BUDGETS)));
  const lineLength = Math.max(
    estimatedLength(line, { ...LINE_BUDGETS, zoeira }), estimatedLength(inactiveLine, { ...LINE_BUDGETS, zoeira }));
  const ranking = WEEKLY_MAX_PLAYERS * (lineLength + 2);
  if (estimatedLength(template, { ...TEMPLATE_BUDGETS, ranking }) > 10000) {
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
  const message = render(selected.template, {
    jogo: game === 'cs2' ? 'CS2' : 'LOL',
    periodo: period,
    ranking: lines.join('\n\n'),
    destaque: active[0]?.name || '—',
    bagre: active.length >= 2 ? active.at(-1).name : '—',
    partidas: String(totalGames),
    vitorias: String(summaries.reduce((sum, stats) => sum + stats.wins, 0)),
    derrotas: String(summaries.reduce((sum, stats) => sum + stats.losses, 0)),
  });
  if (message.length > 10000) throw new MessageConfigError('O resumo semanal excede 10.000 caracteres. Encurte o modelo ou as frases.');
  return { message, players };
}

/** Dados fictícios para a prévia quando ainda não há partidas na semana. */
export function exampleWeekSummaries(game) {
  const names = game === 'cs2'
    ? ['SeuAmigo', 'Fulano', 'Ciclano', 'Beltrano', 'Sicrano']
    : ['SeuAmigo#BR1', 'Fulano#BR1', 'Ciclano#BR1', 'Beltrano#BR1', 'Sicrano#BR1'];
  const rows = [
    [12, 5, 0, 120, 52, 41], [6, 4, 0, 60, 50, 30], [8, 8, 0, 70, 80, 50], [3, 9, 0, 30, 95, 25], [1, 0, 0, 9, 4, 3],
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
