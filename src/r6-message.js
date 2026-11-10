import { calculateKda, createMessageEngine, formatKda, formatMatchDate, MessageConfigError } from './message.js';

// Mensagens do Rainbow Six Siege: variáveis, modelos e zoeiras próprios. Validação, escolha determinística
// e renderização vêm do motor comum em message.js.

/** Crédito exigido pela stats.cc em todo resumo; fica fora do editor e não pode ser removido. */
export const R6_CREDIT = '📊 Data by Stats.cc';

const integer = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
};
const present = value => value !== null && value !== undefined && Number.isFinite(Number(value));

export const R6_MESSAGE_VARIABLES = [
  { key: 'jogo', label: 'Jogo', description: 'Nome do jogo da partida.', example: 'R6' },
  { key: 'modo', label: 'Modo de jogo', description: 'Ranqueada, Padrão ou Legend Division.', example: 'Ranqueada' },
  { key: 'resultado', label: 'Resultado', description: 'Vitória, derrota, empate, abandono ou rendição do jogador.', example: 'DERROTA' },
  { key: 'resultado_emoji', label: 'Emoji do resultado', description: '🟢 para vitória, 🔴 para derrota ou abandono e 🟡 para empate.', example: '🔴' },
  { key: 'player', label: 'Player', description: 'Nick do jogador na partida.', example: 'SeuAmigo' },
  { key: 'nick', label: 'Nick', description: 'Mesmo nome do jogador, para frases e textos curtos.', example: 'SeuAmigo' },
  { key: 'plataforma', label: 'Plataforma', description: 'PC, PlayStation ou Xbox.', example: 'PC' },
  { key: 'mapa', label: 'Mapa', description: 'Nome do mapa, como Clubhouse ou Oregon.', example: 'Clubhouse' },
  { key: 'placar', label: 'Placar', description: 'Rounds da equipe do jogador × rounds do adversário.', example: '2 x 4' },
  { key: 'frag', label: 'Frag', description: 'Abates, mortes e assistências juntos.', example: '3/9/1' },
  { key: 'kills', label: 'Abates', description: 'Quantidade de abates.', example: '3' },
  { key: 'deaths', label: 'Mortes', description: 'Quantidade de mortes.', example: '9' },
  { key: 'assists', label: 'Assistências', description: 'Quantidade de assistências.', example: '1' },
  { key: 'kda', label: 'KDA', description: '(Abates + assistências) dividido pelas mortes; usa 1 se não houve mortes.', example: '0,44' },
  { key: 'rounds', label: 'Rounds', description: 'Quantidade de rounds jogados.', example: '6' },
  { key: 'hs', label: 'Headshots', description: 'Percentual de abates com tiro na cabeça.', example: '33%' },
  { key: 'aberturas', label: 'Aberturas', description: 'Abates de abertura / mortes de abertura (quem morreu primeiro no round).', example: '0/3' },
  { key: 'clutches', label: 'Clutches', description: 'Clutches vencidos (1 contra vários).', example: '0' },
  { key: 'rank', label: 'Rank', description: 'Rank depois da partida (só Ranqueada e Legend Division).', example: 'Gold II' },
  { key: 'pontos', label: 'Pontos', description: 'Pontos de rank ganhos ou perdidos na partida.', example: '-21' },
  { key: 'data', label: 'Data da partida', description: 'Encerramento da partida no horário de São Paulo.', example: '10/11/2026, 21:00' },
  { key: 'partida_id', label: 'Código da partida', description: 'Identificador da partida na stats.cc.', example: '0b7c5d6e-1f2a-4b3c-8d9e-0f1a2b3c4d5e' },
  { key: 'zoeira', label: 'Zoeira', description: 'Uma frase da categoria de desempenho desta partida.', example: 'KKKKKKKKKKKKK SEUAMIGO VIROU TAPETE EM CLUBHOUSE' },
];

const CATEGORIES = ['feed', 'normal', 'carry'];
const VALUE_LENGTH_BUDGETS = {
  jogo: 10, modo: 20, resultado: 20, resultado_emoji: 2, player: 64, nick: 64, plataforma: 20, mapa: 40, placar: 20,
  frag: 32, kills: 10, deaths: 10, assists: 10, kda: 20, rounds: 10, hs: 10, aberturas: 20, clutches: 10,
  rank: 40, pontos: 12, data: 25, partida_id: 64,
};

const DEFAULT_CONFIG = {
  templates: [
    {
      id: 'resumo-completo', name: 'Resumo completo', enabled: true,
      text: [
        '🎮 Jogo: {{jogo}}', 'Modo: {{modo}}', 'Resultado: {{resultado}} {{resultado_emoji}}',
        'Mapa: {{mapa}}', 'Placar: {{placar}}', 'Player: {{player}}', 'Frag: {{frag}}',
        'KDA: {{kda}}', 'Rank: {{rank}} ({{pontos}})', '', '{{zoeira}}',
      ].join('\n'),
    },
    {
      id: 'placar-do-grupo', name: 'Placar do grupo', enabled: false,
      text: [
        '📣 SAIU O PLACAR DO {{jogo}}!', 'Modo: {{modo}} · {{mapa}}',
        '{{resultado_emoji}} {{player}}: {{resultado}} ({{placar}})', '⚔️ {{frag}} · KDA {{kda}} · HS {{hs}}',
        '🚪 Aberturas {{aberturas}} · Clutches {{clutches}}', '', '{{zoeira}}',
      ].join('\n'),
    },
    {
      id: 'pos-game', name: 'Resenha pós-game', enabled: false,
      text: [
        '🗞️ Boletim do pós-game | {{jogo}}', 'Modo: {{modo}} · {{plataforma}}',
        '{{nick}} jogou {{mapa}} e terminou {{frag}}.', '{{resultado}} {{resultado_emoji}} no placar {{placar}}.',
        'HS: {{hs}} | Aberturas: {{aberturas}} | Clutches: {{clutches}} | KDA: {{kda}}', 'Rank: {{rank}} ({{pontos}})',
        '', '{{zoeira}}',
      ].join('\n'),
    },
  ],
  phrases: {
    feed: [
      'KKKKKKKKKKKKK {{nick}} VIROU TAPETE EM {{mapa}}',
      '{{deaths}} mortes. O drone inimigo já te reconhece pelo nome, {{nick}}.',
      '{{frag}} em {{mapa}}. Até o refém teve mais impacto que você.',
      'Morreu na fase de preparação ou só pareceu? KDA {{kda}}.',
      '{{nick}} foi dar spawn peek e virou estatística do outro time.',
      'Aberturas {{aberturas}}: você abriu o round, só que pro time inimigo.',
      '{{hs}} de HS. Tava mirando no pé pra não machucar ninguém?',
      'Parede reforçada teve mais presença no round que {{nick}}.',
      '{{deaths}} mortes em {{mapa}}. Passou mais tempo no replay da própria morte que vivo.',
      'KDA {{kda}}. O time jogou 4 contra 5 e ainda teve que te ouvir no voice.',
      'Rapel na janela, tiro na cara, tela cinza. Resumo da partida de {{nick}}.',
      '{{frag}}. Desinstala e reinstala, vai que o problema é o jogo.',
      '{{nick}} entrou no objetivo só pra conferir se a bomba era bonita.',
      'Esse {{frag}} merecia ban por antijogo, {{nick}}.',
    ],
    normal: [
      'NÃO FEZ MAIS QUE A OBRIGAÇÃO',
      'KDA {{kda}}. Nem fede nem cheira, {{nick}}.',
      '{{frag}} em {{mapa}}. Serviço de estagiário: fez, mas ninguém notou.',
      'Placar {{placar}}. A resenha no grupo foi mais disputada que a partida.',
      'Jogou de roamer da própria irrelevância. {{frag}}.',
      '{{resultado}} em {{mapa}} e ninguém vai lembrar da sua participação.',
      'Clutches vencidos: {{clutches}}. O resto do tempo foi turismo pelo mapa.',
      'Drone, reforço, morre no fim. Rotina de quem só cumpre tabela, {{nick}}.',
      'Partida nota 5 em {{mapa}}. E nota 5 aqui é reprovação.',
      '{{hs}} de HS. Mirou no peito igual quem tem medo de acertar.',
      'Jogou pro gasto. Igual café de padaria: ninguém reclama, ninguém elogia.',
      'KDA {{kda}}: não atrapalhou. É o máximo de elogio que sai daqui.',
      '{{nick}} trocou um por um a partida inteira. Isso é jogar ou contabilidade?',
    ],
    carry: [
      'TÁ, FOI BEM. NÃO SE ACOSTUMA KKKKK',
      '{{frag}} em {{mapa}}. Quem tava na conta, {{nick}}? Pode falar.',
      'KDA {{kda}}. Comemora rápido que na próxima volta a ser tapete.',
      '{{kills}} abates e já tá se achando no mundial. Desce, {{nick}}.',
      'Boa partida. Guarda esse print, que vai demorar pra ter outro.',
      '{{hs}} de HS. Suspeito. Alguém confere essa config aí.',
      '{{nick}} jogou bem. Anota a data, que é evento raro.',
      'Aberturas {{aberturas}}. Hoje o entry foi você, e não o inimigo. Milagre.',
      'O time inimigo devia estar de olho fechado pra deixar {{nick}} fazer {{frag}}.',
      'Elogio liberado só hoje. Amanhã o grupo volta a te zoar, {{nick}}.',
      'Carregou hoje pra justificar as próximas dez derrotas.',
      '{{clutches}} clutches vencidos. Tá bom, toma um elogio, mas devolve amanhã.',
    ],
  },
};

/** Elogio na partida do R6: KDA de pelo menos 4 e vitória (decisão do usuário). Derrota, empate ou abandono nunca recebem elogio. */
export const R6_PRAISE_MIN_KDA = 4;
export function classifyR6Performance(match) {
  const kda = calculateKda(match);
  if (kda < 1) return 'feed';
  const won = match.result === 'win' || (match.result === undefined && match.win === true);
  return kda >= R6_PRAISE_MIN_KDA && won ? 'carry' : 'normal';
}

const RESULT_LABELS = { win: 'VITÓRIA', loss: 'DERROTA', draw: 'EMPATE' };
const OUTCOME_LABELS = { abandon: 'ABANDONO', surrender: 'RENDIÇÃO', forfeit: 'DERROTA POR W.O.' };

function matchValues(match) {
  const kills = integer(match.kills), deaths = integer(match.deaths), assists = integer(match.assists);
  const player = String(match.playerName || 'Jogador');
  const result = match.result === 'win' || match.win === true ? 'win' : match.result === 'draw' ? 'draw' : 'loss';
  const delta = present(match.rankPointsDelta) ? Math.trunc(Number(match.rankPointsDelta)) : null;
  return {
    jogo: 'R6', modo: String(match.mode || 'N/A'),
    resultado: OUTCOME_LABELS[match.outcome] || RESULT_LABELS[result],
    resultado_emoji: { win: '🟢', loss: '🔴', draw: '🟡' }[result],
    player, nick: player,
    plataforma: String(match.platformLabel || 'N/A'),
    mapa: String(match.mapLabel || 'N/A'),
    placar: String(match.score || 'N/A'),
    frag: `${kills}/${deaths}/${assists}`, kills: String(kills), deaths: String(deaths), assists: String(assists),
    kda: formatKda(match),
    // Valores que a fonte não informou aparecem como N/A: nada é estimado.
    rounds: present(match.rounds) ? String(integer(match.rounds)) : 'N/A',
    hs: present(match.headshotPercent) ? `${Math.round(Number(match.headshotPercent))}%` : 'N/A',
    aberturas: present(match.openingKills) && present(match.openingDeaths)
      ? `${integer(match.openingKills)}/${integer(match.openingDeaths)}` : 'N/A',
    clutches: present(match.clutchWins) ? String(integer(match.clutchWins)) : 'N/A',
    rank: match.rankLabel ? String(match.rankLabel) : 'N/A',
    pontos: delta === null ? 'N/A' : delta > 0 ? `+${delta}` : String(delta),
    data: formatMatchDate(match.endedAt), partida_id: String(match.riotMatchId || match.id || 'N/A'),
  };
}

function previewMatch(scenario) {
  const scenarios = {
    feed: {
      mapLabel: 'Clubhouse', kills: 3, deaths: 9, assists: 1, headshotPercent: 33, rounds: 6, score: '2 x 4',
      openingKills: 0, openingDeaths: 3, clutchWins: 0, rankLabel: 'Gold II', rankPointsDelta: -21, result: 'loss', outcome: 'loss', win: false,
    },
    normal: {
      mapLabel: 'Oregon', kills: 7, deaths: 6, assists: 2, headshotPercent: 57, rounds: 9, score: '5 x 4',
      openingKills: 1, openingDeaths: 1, clutchWins: 1, rankLabel: 'Gold I', rankPointsDelta: 19, result: 'win', outcome: 'win', win: true,
    },
    carry: {
      mapLabel: 'Bank', kills: 12, deaths: 2, assists: 3, headshotPercent: 67, rounds: 8, score: '5 x 3',
      openingKills: 4, openingDeaths: 0, clutchWins: 2, rankLabel: 'Platinum V', rankPointsDelta: 27, result: 'win', outcome: 'win', win: true,
    },
  };
  if (!Object.hasOwn(scenarios, scenario)) throw new MessageConfigError('Escolha uma prévia: feed, normal ou carry.');
  return {
    id: `preview-${scenario}`, game: 'r6', playerName: 'SeuAmigo', mode: 'Ranqueada', playlist: 'ranked',
    platformLabel: 'PC', endedAt: new Date().toISOString(), ...scenarios[scenario],
  };
}

/** Campos da partida salva que alimentam a prévia (rota /api/message-preview com matchId). */
export const R6_MATCH_FIELDS = ['playerName', 'mode', 'playlist', 'platformLabel', 'mapLabel', 'map', 'score', 'kills', 'deaths',
  'assists', 'headshotPercent', 'rounds', 'openingKills', 'openingDeaths', 'clutchWins', 'rankLabel', 'rankPointsDelta',
  'outcome', 'result', 'win', 'endedAt'];

export const r6Messages = createMessageEngine({
  game: 'r6', variables: R6_MESSAGE_VARIABLES, categories: CATEGORIES, budgets: VALUE_LENGTH_BUDGETS,
  defaults: DEFAULT_CONFIG, values: matchValues, classify: classifyR6Performance, previewMatch, footer: R6_CREDIT,
  ui: {
    categories: [
      { key: 'feed', label: 'Zoeira', range: 'KDA < 1', band: 'feed' },
      { key: 'normal', label: 'Obrigação', range: 'KDA ≥ 1 sem elogio (KDA < 4, derrota, empate ou abandono)', band: 'normal' },
      { key: 'carry', label: 'Elogio', range: 'KDA ≥ 4 e vitória', band: 'carry' },
    ],
    scenarios: [
      { key: 'feed', label: 'Zoeira · 3/9/1 · KDA 0,44' },
      { key: 'normal', label: 'Obrigação · 7/6/2 · KDA 1,50' },
      { key: 'carry', label: 'Elogio · 12/2/3 · KDA 7,50' },
    ],
  },
});
