import { calculateKda, createMessageEngine, formatKda, formatMatchDate, MessageConfigError } from './message.js';

// Mensagens do Counter-Strike 2: variáveis, modelos e zoeiras próprios. A validação, a escolha
// determinística e a renderização vêm do motor comum em message.js.
const integer = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
};

export const CS2_MESSAGE_VARIABLES = [
  { key: 'jogo', label: 'Jogo', description: 'Nome do jogo da partida.', example: 'CS2' },
  { key: 'modo', label: 'Modo de jogo', description: 'Premier ou Competitivo.', example: 'Premier' },
  { key: 'resultado', label: 'Resultado', description: 'Vitória, derrota ou empate do jogador.', example: 'DERROTA' },
  { key: 'resultado_emoji', label: 'Emoji do resultado', description: '🟢 para vitória, 🔴 para derrota ou 🟡 para empate.', example: '🔴' },
  { key: 'player', label: 'Player', description: 'Nome do jogador na Steam.', example: 'SeuAmigo' },
  { key: 'nick', label: 'Nick', description: 'Mesmo nome do jogador, para frases e textos curtos.', example: 'SeuAmigo' },
  { key: 'frag', label: 'Frag', description: 'Abates, mortes e assistências juntos.', example: '8/17/3' },
  { key: 'kills', label: 'Abates', description: 'Quantidade de abates.', example: '8' },
  { key: 'deaths', label: 'Mortes', description: 'Quantidade de mortes.', example: '17' },
  { key: 'assists', label: 'Assistências', description: 'Quantidade de assistências.', example: '3' },
  { key: 'kda', label: 'KDA', description: '(Abates + assistências) dividido pelas mortes; usa 1 se não houve mortes.', example: '0,65' },
  { key: 'mapa', label: 'Mapa', description: 'Nome do mapa, como Mirage ou Inferno.', example: 'Inferno' },
  { key: 'placar', label: 'Placar', description: 'Rounds da equipe do jogador × rounds do adversário.', example: '7 x 13' },
  { key: 'adr', label: 'ADR', description: 'Dano médio por round, informado pelo Leetify.', example: '54,3' },
  { key: 'dano', label: 'Dano total', description: 'Dano total causado na partida.', example: '1.086' },
  { key: 'rounds', label: 'Rounds', description: 'Quantidade de rounds jogados.', example: '20' },
  { key: 'mvps', label: 'MVPs', description: 'Estrelas de MVP conquistadas.', example: '1' },
  { key: 'hs', label: 'Headshots', description: 'Percentual de abates com tiro na cabeça.', example: '38%' },
  { key: 'data', label: 'Data da partida', description: 'Encerramento da partida no horário de São Paulo.', example: '06/11/2026, 09:00' },
  { key: 'partida_id', label: 'Código da partida', description: 'Código de compartilhamento da partida na Valve.', example: 'CSGO-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE' },
  { key: 'zoeira', label: 'Zoeira', description: 'Uma frase da categoria de desempenho desta partida.', example: 'KKKKKKKKKKKKK FOI FIGURANTE EM INFERNO' },
];

const CATEGORIES = ['feed', 'normal', 'carry'];
const VALUE_LENGTH_BUDGETS = {
  jogo: 10, modo: 20, resultado: 10, resultado_emoji: 2, player: 64, nick: 64, frag: 32, kills: 10,
  deaths: 10, assists: 10, kda: 20, mapa: 40, placar: 20, adr: 20, dano: 20, rounds: 10, mvps: 10,
  hs: 10, data: 25, partida_id: 64,
};

const DEFAULT_CONFIG = {
  templates: [
    {
      id: 'resumo-completo', name: 'Resumo completo', enabled: true,
      text: [
        '🎮 Jogo: {{jogo}}', 'Modo: {{modo}}', 'Resultado: {{resultado}} {{resultado_emoji}}',
        'Mapa: {{mapa}}', 'Placar: {{placar}}', 'Player: {{player}}', 'Frag: {{frag}}',
        'KDA: {{kda}}', 'ADR: {{adr}}', '', '{{zoeira}}',
      ].join('\n'),
    },
    {
      id: 'placar-do-grupo', name: 'Placar do grupo', enabled: false,
      text: [
        '📣 SAIU O PLACAR DO {{jogo}}!', 'Modo: {{modo}} · {{mapa}}',
        '{{resultado_emoji}} {{player}}: {{resultado}} ({{placar}})', '⚔️ {{frag}} · KDA {{kda}}',
        '💥 ADR {{adr}} · {{dano}} de dano em {{rounds}} rounds', '', '{{zoeira}}',
      ].join('\n'),
    },
    {
      id: 'pos-game', name: 'Resenha pós-game', enabled: false,
      text: [
        '🗞️ Boletim do pós-game | {{jogo}}', 'Modo: {{modo}}',
        '{{nick}} jogou {{mapa}} e terminou {{frag}}.', '{{resultado}} {{resultado_emoji}} no placar {{placar}}.',
        'ADR: {{adr}} | HS: {{hs}} | MVPs: {{mvps}} | KDA: {{kda}}', '', '{{zoeira}}',
      ].join('\n'),
    },
  ],
  phrases: {
    feed: [
      'KKKKKKKKKKKKK {{nick}} FOI FIGURANTE EM {{mapa}}',
      '{{deaths}} mortes? O inimigo já te chama de loja de conveniência, {{nick}}.',
      '{{adr}} de ADR em {{mapa}}. Era pra ser dano ou cócegas? KKKKK',
      '{{frag}} no {{modo}}. Vai treinar spray no deathmatch, {{nick}}.',
      'O {{mapa}} agradece o buffet que {{nick}} serviu pro time inimigo.',
      'KDA {{kda}}: o time jogou com um a menos e ainda deu pra ouvir você no chat KKKKK',
      '{{nick}} entrou no bomb site só pra dar bom dia pro adversário.',
      'Com {{adr}} de ADR até o bot do casual joga melhor KKKKK',
    ],
    normal: [
      'NÃO FEZ MAIS QUE A OBRIGAÇÃO',
      'KDA {{kda}}: tá ok, {{nick}}. Fez a parte que era sua em {{mapa}}.',
      '{{frag}} e {{adr}} de ADR. Serviço cumprido, sem faixa de MVP.',
      'Nem herói, nem vilão. {{nick}} foi o figurante em {{mapa}}.',
      'Placar {{placar}}. A resenha foi mais disputada que a partida KKKKK',
      'Tá dentro do esperado. Mais uma na conta e segue o jogo.',
    ],
    carry: [
      'JOGOU BEM, MAS SEGURA A EMOÇÃO KKKKK',
      '{{frag}} em {{mapa}} foi bonito. A entrevista fica pra outra hora.',
      'KDA {{kda}} e {{adr}} de ADR: pode comemorar, {{nick}}, mas sem discurso de campeão.',
      'Hoje {{nick}} carregou de verdade. Repete amanhã pra gente acreditar.',
      '{{kills}} abates e uma boa atuação. Calma que ainda não é o Major KKKKK',
      'Mandou bem com {{frag}}. O grupo reconhece, mas não vai fazer estátua.',
      '{{dano}} de dano em {{mapa}}. O time agradece e o adversário nem tanto.',
      'Boa partida! Já pode ganhar um elogio e voltar pra fila.',
    ],
  },
};

/** Nome legível do mapa: `de_mirage` vira `Mirage`. */
export function mapLabel(map) {
  const name = String(map || '').trim().replace(/^(?:de|cs|ar|gd|dz)_/i, '').replace(/_/g, ' ');
  return name ? name.replace(/\b\p{L}/gu, letter => letter.toUpperCase()) : 'Desconhecido';
}

export function classifyCs2Performance(match) {
  const kda = calculateKda(match);
  if (kda < 1) return 'feed';
  return kda < 2.5 ? 'normal' : 'carry';
}

function matchValues(match) {
  const kills = integer(match.kills), deaths = integer(match.deaths), assists = integer(match.assists);
  const player = String(match.playerName || 'Jogador');
  const result = match.result === 'win' || match.win === true ? 'win' : match.result === 'draw' ? 'draw' : 'loss';
  const adr = Number(match.adr);
  const hs = Number(match.headshotPercent);
  return {
    jogo: 'CS2', modo: String(match.mode || 'Premier'),
    resultado: { win: 'VITÓRIA', loss: 'DERROTA', draw: 'EMPATE' }[result],
    resultado_emoji: { win: '🟢', loss: '🔴', draw: '🟡' }[result],
    player, nick: player,
    frag: `${kills}/${deaths}/${assists}`, kills: String(kills), deaths: String(deaths), assists: String(assists),
    kda: formatKda(match), mapa: mapLabel(match.map), placar: String(match.score || 'N/A'),
    // Valores que a fonte não informou aparecem como N/A: nada é estimado.
    adr: Number.isFinite(adr) && match.adr !== null ? adr.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : 'N/A',
    dano: match.damage === null || match.damage === undefined ? 'N/A' : integer(match.damage).toLocaleString('pt-BR'),
    rounds: match.rounds === null || match.rounds === undefined ? 'N/A' : String(integer(match.rounds)),
    mvps: match.mvps === null || match.mvps === undefined ? 'N/A' : String(integer(match.mvps)),
    hs: Number.isFinite(hs) && match.headshotPercent !== null ? `${Math.round(hs)}%` : 'N/A',
    data: formatMatchDate(match.endedAt), partida_id: String(match.riotMatchId || match.id || 'N/A'),
  };
}

function previewMatch(scenario) {
  const scenarios = {
    feed: { map: 'de_inferno', kills: 8, deaths: 17, assists: 3, adr: 54.3, damage: 1086, rounds: 20, mvps: 1, headshotPercent: 38, score: '7 x 13', result: 'loss', win: false },
    normal: { map: 'de_mirage', kills: 15, deaths: 14, assists: 4, adr: 78.2, damage: 1877, rounds: 24, mvps: 3, headshotPercent: 44, score: '13 x 11', result: 'win', win: true },
    carry: { map: 'de_ancient', kills: 28, deaths: 11, assists: 6, adr: 112.4, damage: 2248, rounds: 20, mvps: 6, headshotPercent: 52, score: '13 x 7', result: 'win', win: true },
  };
  if (!Object.hasOwn(scenarios, scenario)) throw new MessageConfigError('Escolha uma prévia: feed, normal ou carry.');
  return {
    id: `preview-${scenario}`, game: 'cs2', playerName: 'SeuAmigo', mode: 'Premier',
    endedAt: new Date().toISOString(), ...scenarios[scenario],
  };
}

/** Campos da partida salva que alimentam a prévia (rota /api/message-preview com matchId). */
export const CS2_MATCH_FIELDS = ['playerName', 'map', 'mode', 'kills', 'deaths', 'assists', 'adr', 'damage', 'rounds',
  'mvps', 'headshotPercent', 'score', 'result', 'win', 'endedAt'];

export const cs2Messages = createMessageEngine({
  game: 'cs2', variables: CS2_MESSAGE_VARIABLES, categories: CATEGORIES, budgets: VALUE_LENGTH_BUDGETS,
  defaults: DEFAULT_CONFIG, values: matchValues, classify: classifyCs2Performance, previewMatch,
  ui: {
    categories: [
      { key: 'feed', label: 'Zoeira', range: 'KDA < 1', band: 'feed' },
      { key: 'normal', label: 'Obrigação', range: '1 ≤ KDA < 2,5', band: 'normal' },
      { key: 'carry', label: 'Elogio', range: 'KDA ≥ 2,5', band: 'carry' },
    ],
    scenarios: [
      { key: 'feed', label: 'Zoeira · 8/17/3 · KDA 0,65' },
      { key: 'normal', label: 'Obrigação · 15/14/4 · KDA 1,36' },
      { key: 'carry', label: 'Elogio · 28/11/6 · KDA 3,09' },
    ],
  },
});
