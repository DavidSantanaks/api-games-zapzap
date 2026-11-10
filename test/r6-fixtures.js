// Fixtures fictícias do R6 compartilhadas pelos testes. Nenhuma chamada real à stats.cc.
const PROFILE = '11111111-2222-4333-8444-555555555555';

export function r6Item(id, overrides = {}, summary = {}) {
  return {
    id, map: 'clubhouse', mode: 'ranked-bomb', playlist: 'ranked', scores: [4, 2], datacenter: 'sa-east',
    started_at: '2026-11-10T20:30:00.000Z', ended_at: '2026-11-10T21:00:00.000Z', end_reason: 'finished',
    player_summary: {
      profile_id: PROFILE, username: 'AmigoR6', outcome: 'win', team: 0, kills: 9, deaths: 4, assists: 3,
      headshots: 6, rounds: 6, round_wins: 4, round_losses: 2, opening_kills: 2, opening_deaths: 1,
      clutch_1v1_wins: 1, clutch_1v2_wins: 0, clutch_1v3_wins: 0, clutch_1v4_wins: 0, clutch_1v5_wins: 0,
      clutch_1v1_losses: 0, clutch_1v2_losses: 1, clutch_1v3_losses: 0, clutch_1v4_losses: 0, clutch_1v5_losses: 0,
      ...summary,
    },
    ranked_session: { rank: 'v7-gold-ii', rank_points: 2834, rank_points_delta: 23, wins: 1, losses: 0, abandons: 0, created_at: '2026-11-10T21:00:00.000Z' },
    ...overrides,
  };
}

/** Servidor stats.cc simulado: rotas → [status, corpo, cabeçalhos]. */
export function fakeStatsCc(routes) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const { pathname, search } = new URL(url);
    calls.push({ path: pathname.replace(/^\/siege/, '') + search, key: options.headers?.['x-api-key'] });
    const path = pathname.replace(/^\/siege/, '');
    const key = Object.keys(routes).find(route => (route.includes('?') ? path + search === route : path === route));
    let handler = key ? routes[key] : [404, { kind: 'not_found', message: 'Not found' }];
    if (typeof handler === 'function') handler = handler(new URL(url));
    const [status, body, headers = {}] = handler;
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  };
  return { fetchImpl, calls };
}
