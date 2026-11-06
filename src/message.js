import { gameModeLabel } from './game-mode.js';

const integer = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
};

export class MessageConfigError extends Error {
  constructor(message) { super(message); this.name = 'MessageConfigError'; }
}

export const MESSAGE_VARIABLES = [
  { key: 'jogo', label: 'Jogo', description: 'Nome do jogo da partida.', example: 'LOL' },
  { key: 'modo', label: 'Modo de jogo', description: 'Fila ou modo da partida, como Ranqueada Solo/Duo, Flex, Normal ou ARAM.', example: 'Ranqueada Solo/Duo' },
  { key: 'resultado', label: 'Resultado', description: 'Vitória ou derrota do jogador.', example: 'DERROTA' },
  { key: 'resultado_emoji', label: 'Emoji do resultado', description: '🟢 para vitória ou 🔴 para derrota.', example: '🔴' },
  { key: 'player', label: 'Player completo', description: 'Riot ID com nick e tag.', example: 'SeuAmigo#BR1' },
  { key: 'nick', label: 'Nick', description: 'Nome do jogador, sem a tag.', example: 'SeuAmigo' },
  { key: 'tag', label: 'Tag', description: 'Tag do Riot ID, sem #.', example: 'BR1' },
  { key: 'frag', label: 'Frag', description: 'Abates, mortes e assistências juntos.', example: '1/5/9' },
  { key: 'kills', label: 'Abates', description: 'Quantidade de abates.', example: '1' },
  { key: 'deaths', label: 'Mortes', description: 'Quantidade de mortes.', example: '5' },
  { key: 'assists', label: 'Assistências', description: 'Quantidade de assistências.', example: '9' },
  { key: 'kda', label: 'KDA', description: '(Abates + assistências) dividido pelas mortes; usa 1 se não houve mortes.', example: '2,00' },
  { key: 'personagem', label: 'Personagem', description: 'Campeão utilizado pelo jogador.', example: 'Yasuo' },
  { key: 'farm', label: 'Farm / CS', description: 'Tropas e monstros neutros abatidos.', example: '124' },
  { key: 'lane', label: 'Lane', description: 'Posição do jogador: TOP, JG, MID, ADC, SUP, ARAM ou N/A.', example: 'MID' },
  { key: 'gold', label: 'Gold formatado', description: 'Ouro obtido, com separador de milhar.', example: '10.000' },
  { key: 'gold_bruto', label: 'Gold sem formato', description: 'Ouro obtido sem separadores.', example: '10000' },
  { key: 'duracao', label: 'Duração', description: 'Duração da partida em minutos e segundos.', example: '30:00' },
  { key: 'duracao_segundos', label: 'Duração em segundos', description: 'Duração total em segundos.', example: '1800' },
  { key: 'data', label: 'Data da partida', description: 'Encerramento da partida no horário de São Paulo.', example: '06/11/2026, 09:00' },
  { key: 'partida_id', label: 'ID da partida', description: 'Identificador da partida na Riot.', example: 'BR1_123456789' },
  { key: 'zoeira', label: 'Zoeira', description: 'Uma frase da categoria de desempenho desta partida.', example: 'KKKKKKKKKKKKK FEEDOU DEMAIS' },
];

const VARIABLE_KEYS = new Set(MESSAGE_VARIABLES.map(variable => variable.key));
const CATEGORIES = ['feed', 'carry', 'support', 'normal'];
// Generous character budgets for the normalized Riot fields. Check every model
// before saving so a later player or phrase cannot activate an oversized draft.
const VALUE_LENGTH_BUDGETS = {
  jogo: 10, modo: 128, resultado: 10, resultado_emoji: 2, player: 64, nick: 50, tag: 10,
  frag: 32, kills: 10, deaths: 10, assists: 10, kda: 20, personagem: 100,
  farm: 10, lane: 10, gold: 20, gold_bruto: 20, duracao: 22,
  duracao_segundos: 20, data: 25, partida_id: 64,
};
// Snapshot of the original pools for the one-time, exact-match migration.
// Never use these to overwrite phrases authored by the user.
const LEGACY_PHRASE_POOLS = {
  feed: [
    'KKKKKKKKKKKKK FEEDOU DEMAIS',
    '{{nick}} abriu uma franquia de buffet na {{lane}} KKKKK',
    '{{deaths}} mortes? O inimigo já salvou teu contato como patrocinador.',
    'Foi de {{personagem}} ou de motoboy? Só entregou KKKKK',
    'Esse {{frag}} veio com frete grátis pro time inimigo.',
    'O respawn já está te chamando de cliente fiel, {{nick}}.',
    'Jogou {{duracao}} e o destaque foi o caminho da base KKKKK',
    'A {{lane}} virou rodízio e {{nick}} bancou a conta.',
  ],
  carry: [
    'NÃO FEZ MAIS QUE A OBRIGAÇÃO',
    '{{frag}} de {{personagem}}? Pode guardar a entrevista, amanhã tem mais.',
    'Carregou hoje só pra justificar as próximas dez partidas KKKKK',
    '{{nick}} resolveu ligar o monitor. O grupo agradece.',
    'Boa partida. Já pode voltar ao desempenho habitual.',
    '{{kills}} abates e já está se achando no mundial KKKKK',
    'O {{personagem}} fez a parte dele. Agora explica as outras partidas.',
    'Com {{gold}} de gold até eu... mentira, eu não fazia isso não KKKKK',
  ],
  support: [
    'CARREGOU NA ASSISTÊNCIA E AINDA VÃO CULPAR O SUP KKKKK',
    '{{assists}} assistências e nem um obrigado. Vida de sup.',
    '{{nick}} fez {{frag}} e ainda teve que ser babá do ADC KKKKK',
    'O time levou os abates, {{personagem}} levou o trabalho.',
    'Visão de jogo, {{assists}} assistências e zero reconhecimento. Clássico.',
    'Se assistência pagasse aluguel, {{nick}} comprava o mapa.',
  ],
  normal: [
    'O IMPORTANTE É SE DIVERTIR... FOI DIVERTIDO PRA QUEM? KKKKK',
    '{{frag}}: participou da partida e do grupo, pelo menos.',
    'Nem herói, nem vilão. {{nick}} foi o figurante da {{lane}}.',
    'O {{personagem}} entrou, jogou e foi embora. Cinema.',
    '{{duracao}} de partida pra render esse print KKKKK',
    'Essa partida ficou na média. A resenha, infelizmente, não.',
  ],
};
const DEFAULT_CONFIG = {
  templates: [
    {
      id: 'resumo-completo', name: 'Resumo completo', enabled: true,
      text: [
        '🎮 Jogo: {{jogo}}', 'Modo: {{modo}}', 'Resultado: {{resultado}} {{resultado_emoji}}',
        'Player: {{player}}', 'Frag: {{frag}}', 'Personagem: {{personagem}}',
        'Farm: {{farm}} CS', 'Lane: {{lane}}', 'GOLD: {{gold}}', '', '{{zoeira}}',
      ].join('\n'),
    },
    {
      id: 'placar-do-grupo', name: 'Placar do grupo', enabled: false,
      text: [
        '📣 SAIU O PLACAR DO {{jogo}}!', 'Modo: {{modo}}', '{{resultado_emoji}} {{player}}: {{resultado}}',
        '⚔️ {{personagem}} na {{lane}} — {{frag}}',
        '🌾 {{farm}} CS · 💰 {{gold}} de gold · ⏱️ {{duracao}}', '', '{{zoeira}}',
      ].join('\n'),
    },
    {
      id: 'pos-game', name: 'Resenha pós-game', enabled: false,
      text: [
        '🗞️ Boletim do pós-game | {{jogo}}', 'Modo: {{modo}}',
        '{{nick}} escolheu {{personagem}}, foi de {{lane}} e terminou {{frag}}.',
        '{{resultado}} {{resultado_emoji}} em {{duracao}}.',
        'Farm: {{farm}} CS | Gold: {{gold}} | KDA: {{kda}}', '', '{{zoeira}}',
      ].join('\n'),
    },
  ],
  phrases: {
    feed: [
      'KKKKKKKKKKKKK FEEDOU DEMAIS',
      '{{nick}} abriu uma franquia de buffet na {{lane}} KKKKK',
      '{{deaths}} mortes? O inimigo já salvou teu contato como patrocinador.',
      'Foi de {{personagem}} ou de motoboy? Só entregou KKKKK',
      'Esse {{frag}} veio com frete grátis pro time inimigo.',
      'O respawn já está te chamando de cliente fiel, {{nick}}.',
      'Jogou {{duracao}} e o destaque foi o caminho da base KKKKK',
      'A {{lane}} virou rodízio e {{nick}} bancou a conta.',
    ],
    carry: [
      'JOGOU BEM, MAS SEGURA A EMOÇÃO KKKKK',
      '{{frag}} de {{personagem}} foi bonito. A entrevista fica pra outra hora.',
      'KDA {{kda}}: pode comemorar, {{nick}}, mas sem discurso de campeão.',
      'Hoje {{nick}} ajudou de verdade. Repete amanhã pra gente acreditar.',
      'Boa partida! Já pode ganhar um elogio e voltar pra fila.',
      '{{kills}} abates e uma boa atuação. Calma que ainda não é o mundial KKKKK',
      'O {{personagem}} trabalhou bem hoje. Crédito onde é devido.',
      'Mandou bem com {{frag}}. O grupo reconhece, mas não vai fazer estátua.',
    ],
    support: [
      'BOM TRABALHO, SUP. ELOGIO LIBERADO, MAS SEM SE ACHAR KKKKK',
      '{{assists}} assistências e KDA {{kda}}. Pode aceitar o obrigado, {{nick}}.',
      '{{personagem}} ajudou o time de verdade. Hoje o sup merece crédito.',
      '{{frag}} na SUP foi uma boa participação. A estátua ainda não vem.',
      'Mandou bem no apoio, {{nick}}. Amanhã tem que repetir.',
      'O grupo reconhece esse KDA {{kda}}. Só não vai pedir aumento KKKKK',
    ],
    normal: [
      'NÃO FEZ MAIS QUE A OBRIGAÇÃO',
      'KDA {{kda}}: tá ok, {{nick}}. Fez a parte que era sua.',
      '{{frag}} de {{personagem}}. Serviço cumprido, sem faixa de MVP.',
      'Participou bem o suficiente. Pode guardar o discurso KKKKK',
      'Fez o básico na {{lane}}. O grupo agradece sem fazer festa.',
      'Tá dentro do esperado. Mais uma na conta e segue o jogo.',
    ],
  },
};

export function getDefaultMessageConfig() { return structuredClone(DEFAULT_CONFIG); }
export function getLegacyPhrasePools() { return structuredClone(LEGACY_PHRASE_POOLS); }
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function assertKeys(value, expected, label) {
  if (!record(value)) throw new MessageConfigError(`${label} deve ser um objeto.`);
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some(key => !expected.includes(key))) {
    throw new MessageConfigError(`${label} tem campos ausentes ou não permitidos.`);
  }
}
function validateText(text, { label, max, phrase = false }, allowedKeys = VARIABLE_KEYS) {
  if (typeof text !== 'string' || !text.trim() || text.length > max) {
    throw new MessageConfigError(`${label} deve ter entre 1 e ${max} caracteres.`);
  }
  if (phrase && /[\r\n\u2028\u2029]/.test(text)) throw new MessageConfigError(`${label} deve ocupar uma única linha.`);
  const tokens = /\{\{([\s\S]*?)\}\}/g;
  let token;
  while ((token = tokens.exec(text)) !== null) {
    const key = token[1].trim();
    if (!/^[a-z][a-z0-9_]*$/.test(key) || !allowedKeys.has(key)) {
      throw new MessageConfigError(`${label}: variável não permitida: ${token[0]}. Use os campos da lista.`);
    }
    if (phrase && key === 'zoeira') throw new MessageConfigError(`${label}: {{zoeira}} só pode ser usado no modelo da mensagem.`);
  }
  const remaining = text.replace(tokens, '');
  if (remaining.includes('{{') || remaining.includes('}}')) {
    throw new MessageConfigError(`${label}: variável incompleta. Use o formato {{lane}}.`);
  }
  return text;
}

function estimatedLength(text, budgets) {
  let length = text.length;
  for (const token of text.matchAll(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g)) {
    length += budgets[token[1]] - token[0].length;
  }
  return length;
}

/** Fórmula única de KDA, compartilhada por todos os jogos: (abates + assistências) / máx(1, mortes). */
export function calculateKda(match = {}) {
  return (integer(match.kills) + integer(match.assists)) / Math.max(1, integer(match.deaths));
}
export const formatKda = match => calculateKda(match).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function formatMatchDate(value) {
  const end = new Date(value);
  return Number.isNaN(end.getTime()) ? 'N/A' : new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(end);
}
export function splitPlayerName(value) {
  const player = String(value || 'Jogador');
  const separator = player.lastIndexOf('#');
  return { player, nick: separator < 0 ? player : player.slice(0, separator), tag: separator < 0 ? '' : player.slice(separator + 1) };
}

export function classifyPerformance(match) {
  const kda = calculateKda(match);
  if (kda < 1) return 'feed';
  if (kda < 2.5) return 'normal';
  return match.lane === 'SUP' ? 'support' : 'carry';
}

function selectIndex(seed, size) {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index++) hash = Math.imul(hash ^ seed.charCodeAt(index), 16777619);
  return (hash >>> 0) % size;
}
function render(text, values) {
  // Substitute authored tokens once. Braces inside API values remain literal text.
  return text.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g, (_token, key) => values[key]);
}
function matchValues(match) {
  const kills = integer(match.kills), deaths = integer(match.deaths), assists = integer(match.assists);
  const seconds = integer(match.durationSeconds);
  const { player, nick, tag } = splitPlayerName(match.playerName);
  return {
    jogo: 'LOL', modo: gameModeLabel(match), resultado: match.win ? 'VITÓRIA' : 'DERROTA', resultado_emoji: match.win ? '🟢' : '🔴',
    player, nick, tag,
    frag: `${kills}/${deaths}/${assists}`, kills: String(kills), deaths: String(deaths), assists: String(assists),
    kda: formatKda(match),
    personagem: String(match.champion || 'Desconhecido'), farm: String(integer(match.cs)), lane: String(match.lane || 'N/A'),
    gold: integer(match.gold).toLocaleString('pt-BR'), gold_bruto: String(integer(match.gold)),
    duracao: `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`,
    duracao_segundos: String(seconds), data: formatMatchDate(match.endedAt), partida_id: String(match.riotMatchId || match.id || 'N/A'),
  };
}

function lolPreviewMatch(scenario) {
  const scenarios = {
    feed: { champion: 'Yasuo', kills: 1, deaths: 8, assists: 3, cs: 124, gold: 10_000, lane: 'MID', win: false },
    carry: { champion: 'Jinx', kills: 15, deaths: 2, assists: 8, cs: 242, gold: 18_500, lane: 'ADC', win: true },
    support: { champion: 'Lulu', kills: 1, deaths: 3, assists: 24, cs: 32, gold: 9_850, lane: 'SUP', win: true },
    normal: { champion: 'Yasuo', kills: 1, deaths: 5, assists: 9, cs: 124, gold: 10_000, lane: 'MID', win: false },
  };
  if (!Object.hasOwn(scenarios, scenario)) throw new MessageConfigError('Escolha uma prévia: feed, carry, support ou normal.');
  return {
    id: `preview-${scenario}`, playerName: 'SeuAmigo#BR1',
    durationSeconds: 1800, endedAt: new Date().toISOString(), queueId: 420, gameMode: 'CLASSIC',
    ...scenarios[scenario],
  };
}

/**
 * Motor de mensagens de um jogo. Cada jogo fornece o próprio perfil (variáveis, categorias de zoeira,
 * modelos padrão, valores da partida e prévias); validação, escolha determinística e renderização são comuns.
 */
export function createMessageEngine(profile) {
  const { game, variables, categories, budgets, defaults, values: valuesFor, classify, previewMatch, ui } = profile;
  const keys = new Set(variables.map(variable => variable.key));

  function validateExpansionLengths(templates, phrases) {
    const phraseBudgets = Object.fromEntries(categories.map(category => [
      category, Math.max(...phrases[category].map(phrase => estimatedLength(phrase, budgets))),
    ]));
    for (const template of templates) {
      for (const category of categories) {
        if (estimatedLength(template.text, { ...budgets, zoeira: phraseBudgets[category] }) > 10000) {
          throw new MessageConfigError(`A variação “${template.name}” pode ultrapassar 10.000 caracteres ao preencher os dados e a zoeira. Reduza a repetição de campos ou frases.`);
        }
      }
    }
  }

  function validateConfig(config) {
    assertKeys(config, ['templates', 'phrases'], 'A configuração das mensagens');
    if (!Array.isArray(config.templates) || config.templates.length < 1 || config.templates.length > 10) {
      throw new MessageConfigError('Cadastre entre 1 e 10 variações de mensagem.');
    }
    const ids = new Set();
    const templates = config.templates.map((template, index) => {
      const label = `A variação ${index + 1}`;
      assertKeys(template, ['id', 'name', 'enabled', 'text'], label);
      if (typeof template.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(template.id) || ids.has(template.id)) {
        throw new MessageConfigError(`${label} precisa de um identificador válido e exclusivo.`);
      }
      ids.add(template.id);
      if (typeof template.name !== 'string' || !template.name.trim() || template.name.trim().length > 60) {
        throw new MessageConfigError(`${label} precisa de um nome com até 60 caracteres.`);
      }
      if (typeof template.enabled !== 'boolean') throw new MessageConfigError(`${label} precisa informar se está ativa.`);
      return {
        id: template.id, name: template.name.trim(), enabled: template.enabled,
        text: validateText(template.text, { label: `O texto de “${template.name.trim()}”`, max: 3000 }, keys),
      };
    });
    if (!templates.some(template => template.enabled)) throw new MessageConfigError('Mantenha pelo menos uma variação de mensagem ativa.');
    assertKeys(config.phrases, categories, 'As categorias de zoeira');
    const phrases = {};
    for (const category of categories) {
      const pool = config.phrases[category];
      if (!Array.isArray(pool) || pool.length < 1 || pool.length > 30) {
        throw new MessageConfigError(`A categoria ${category} deve ter entre 1 e 30 frases.`);
      }
      phrases[category] = pool.map((phrase, index) => validateText(phrase, {
        label: `A frase ${index + 1} da categoria ${category}`, max: 300, phrase: true,
      }, keys).trim());
    }
    validateExpansionLengths(templates, phrases);
    return { templates, phrases };
  }

  function formatMessage(match, { config, phrase, templateId, phraseIndex } = {}) {
    const selectedConfig = validateConfig(config === undefined ? structuredClone(defaults) : config);
    const category = classify(match);
    const seed = String(match.riotMatchId || match.id || match.playerName || 'partida');
    const enabled = selectedConfig.templates.filter(template => template.enabled);
    const template = templateId === undefined
      ? enabled[config === undefined ? 0 : selectIndex(`modelo:${seed}`, enabled.length)]
      : selectedConfig.templates.find(template => template.id === templateId);
    if (!template) throw new MessageConfigError('Variação de mensagem não encontrada.');
    const pool = selectedConfig.phrases[category];
    if (phraseIndex !== undefined && (!Number.isInteger(phraseIndex) || phraseIndex < 0 || phraseIndex >= pool.length)) {
      throw new MessageConfigError('Escolha uma frase válida para a categoria desta partida.');
    }
    const selectedPhraseIndex = phraseIndex ?? (config === undefined ? 0 : selectIndex(`frase:${category}:${seed}`, pool.length));
    const phraseText = phrase === undefined ? pool[selectedPhraseIndex]
      : validateText(phrase, { label: 'A frase personalizada', max: 300, phrase: true }, keys);
    const values = valuesFor(match);
    values.zoeira = render(phraseText, values);
    const message = render(template.text, values);
    if (message.length > 10000) throw new MessageConfigError('A mensagem pronta excede 10.000 caracteres. Reduza o modelo ou a frase.');
    return { message, category, templateId: template.id, templateName: template.name, phraseIndex: selectedPhraseIndex, values };
  }

  function createPreview(scenario = 'feed', options = {}) {
    const match = previewMatch(scenario);
    return { match, ...formatMessage(match, options) };
  }

  return {
    game, variables, categories, ui, classify, validateConfig, formatMessage, createPreview,
    defaultConfig: () => structuredClone(defaults),
  };
}

const lolEngine = createMessageEngine({
  game: 'lol', variables: MESSAGE_VARIABLES, categories: CATEGORIES, budgets: VALUE_LENGTH_BUDGETS,
  defaults: DEFAULT_CONFIG, values: matchValues, classify: classifyPerformance, previewMatch: lolPreviewMatch,
  ui: {
    categories: [
      { key: 'feed', label: 'Zoeira', range: 'KDA < 1', band: 'feed' },
      { key: 'normal', label: 'Obrigação', range: '1 ≤ KDA < 2,5', band: 'normal' },
      { key: 'carry', label: 'Elogio', range: 'KDA ≥ 2,5', band: 'carry' },
      { key: 'support', label: 'Elogio ao suporte', range: 'KDA ≥ 2,5 · SUP', band: 'carry' },
    ],
    scenarios: [
      { key: 'feed', label: 'Zoeira · 1/8/3 · KDA 0,50' },
      { key: 'normal', label: 'Obrigação · 1/5/9 · KDA 2,00' },
      { key: 'carry', label: 'Elogio · 15/2/8 · KDA 11,50' },
      { key: 'support', label: 'Elogio ao suporte · 1/3/24 · KDA 8,33' },
    ],
  },
});

export const lolMessages = lolEngine;
export const validateMessageConfig = lolEngine.validateConfig;
export const formatMessage = lolEngine.formatMessage;
export const createPreview = lolEngine.createPreview;
