// Riot's public queue and game-mode constants, checked 2026-11-06:
// https://static.developer.riotgames.com/docs/lol/queues.json
// https://static.developer.riotgames.com/docs/lol/gameModes.json
// Match-v5's gameMode alone is CLASSIC for both ranked and normal games.
const QUEUE_LABELS = new Map([
  [0, 'Personalizada'],
  [2, 'Normal às cegas'], [4, 'Ranqueada Solo/Duo'], [14, 'Normal alternada'],
  [65, 'ARAM'], [100, 'ARAM'],
  [400, 'Normal alternada'], [420, 'Ranqueada Solo/Duo'],
  [430, 'Normal às cegas'], [440, 'Ranqueada Flex'], [450, 'ARAM'],
  [480, 'Swiftplay'], [490, 'Jogo rápido'],
  [700, 'Clash'], [720, 'ARAM Clash'],
  [830, 'Co-op vs IA — introdutório'], [840, 'Co-op vs IA — iniciante'],
  [850, 'Co-op vs IA — intermediário'],
  [870, 'Co-op vs IA — introdutório'], [880, 'Co-op vs IA — iniciante'],
  [890, 'Co-op vs IA — intermediário'],
  [900, 'ARURF'], [1010, 'ARURF de inverno'], [1020, 'Todos por Um'],
  [1200, 'Blitz do Nexus'], [1300, 'Blitz do Nexus'],
  [1400, 'Livro Supremo de Ultimates'],
  [1700, 'Arena'], [1710, 'Arena'],
  [1810, 'Enxame — solo'], [1820, 'Enxame — dupla'],
  [1830, 'Enxame — trio'], [1840, 'Enxame — quarteto'],
  [1900, 'URF'], [2000, 'Tutorial'], [2010, 'Tutorial'], [2020, 'Tutorial'],
  [2300, 'Brawl'], [2400, 'ARAM: Mayhem'],
]);

const MODE_LABELS = new Map([
  ['CLASSIC', 'Clássico'], ['ARAM', 'ARAM'], ['URF', 'URF'],
  ['ONEFORALL', 'Todos por Um'], ['TUTORIAL', 'Tutorial'],
  ['NEXUSBLITZ', 'Blitz do Nexus'], ['GAMEMODEX', 'Blitz do Nexus'],
  ['ULTBOOK', 'Livro Supremo de Ultimates'], ['SWIFTPLAY', 'Swiftplay'],
  ['BRAWL', 'Brawl'], ['CHERRY', 'Arena'], ['STRAWBERRY', 'Enxame'],
]);

/** Also resolves older stored matches which only contain queueId. */
export function gameModeLabel(match = {}) {
  const rawQueue = match.queueId;
  const queueId = typeof rawQueue === 'number' ? rawQueue
    : typeof rawQueue === 'string' && /^\d+$/.test(rawQueue) ? Number(rawQueue) : NaN;
  const hasQueue = Number.isSafeInteger(queueId) && queueId >= 0;
  if (hasQueue && QUEUE_LABELS.has(queueId)) return QUEUE_LABELS.get(queueId);
  const rawMode = typeof match.gameMode === 'string' ? match.gameMode.trim().slice(0, 128) : '';
  if (rawMode) return MODE_LABELS.get(rawMode.toUpperCase()) || rawMode;
  return hasQueue ? `Fila ${queueId}` : 'Modo desconhecido';
}
