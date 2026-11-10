import test from 'node:test';
import assert from 'node:assert/strict';
import { R6Client, R6Error, normalizeR6Match, slugLabel } from '../src/r6.js';
import { fakeStatsCc, r6Item } from './r6-fixtures.js';

// Valores fictícios: nenhuma chamada real à stats.cc.
const KEY = 'chave-ficticia-de-teste';
const PROFILE = '11111111-2222-4333-8444-555555555555';
const M1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const M2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const M3 = 'aaaaaaaa-0000-4000-8000-000000000003';
const CONFIG = {
  platforms: { pc: { slug: 'pc', display: 'PC' }, playstation: { slug: 'playstation', display: 'Playstation' }, xbox: { slug: 'xbox', display: 'Xbox' } },
  maps: { clubhouse: { slug: 'clubhouse', display: 'Clubhouse' } },
  ranks: { 'v7-gold-ii': { slug: 'v7-gold-ii', display: 'Gold II' } },
};

test('normalizes a ranked match from stats.cc without inventing missing fields', () => {
  const match = normalizeR6Match(r6Item(M1), { player: { platformLabel: 'PC' }, labels: { maps: { clubhouse: 'Clubhouse' }, ranks: { 'v7-gold-ii': 'Gold II' } } });
  assert.equal(match.id, M1);
  assert.equal(match.game, 'r6');
  assert.equal(match.mode, 'Ranqueada');
  assert.equal(match.mapLabel, 'Clubhouse');
  assert.equal(match.score, '4 x 2');
  assert.equal(match.result, 'win');
  assert.equal(match.headshotPercent, 67);
  assert.equal(match.clutchWins, 1);
  assert.equal(match.clutchLosses, 1);
  assert.equal(match.rankLabel, 'Gold II');
  assert.equal(match.rankPointsDelta, 23);
  // Time 1 lê o placar invertido.
  assert.equal(normalizeR6Match(r6Item(M1, {}, { team: 1 })).score, '2 x 4');
  // Sem sessão ranqueada (Padrão) e sem headshots: nada é estimado.
  const unranked = normalizeR6Match(r6Item(M2, { playlist: 'unranked', ranked_session: null, map: 'oregon' }, { headshots: null }));
  assert.equal(unranked.mode, 'Padrão');
  assert.equal(unranked.rankLabel, null);
  assert.equal(unranked.rankPointsDelta, null);
  assert.equal(unranked.headshotPercent, null);
  assert.equal(unranked.mapLabel, 'Oregon', 'sem config, o slug vira um nome legível');
  assert.equal(slugLabel('kafe-dostoyevsky'), 'Kafe Dostoyevsky');
});

test('only ranked, unranked and legend-division count; canceled matches are ignored', () => {
  assert.equal(normalizeR6Match(r6Item(M1, { playlist: 'legend-division', ranked_session: null, legend_session: { rank: 'v7-champion-i', rank_points: 5000, rank_points_delta: -12 } })).mode, 'Legend Division');
  for (const playlist of ['quick-match', 'event', 'arcade', 'custom', 'training', 'dual-front', 'pve-casual-game']) {
    assert.equal(normalizeR6Match(r6Item(M1, { playlist })), null, playlist);
  }
  for (const outcome of ['self-cancel', 'team-cancel', 'enemy-cancel']) assert.equal(normalizeR6Match(r6Item(M1, {}, { outcome })), null);
  assert.equal(normalizeR6Match(r6Item(M1, { end_reason: 'canceled' })), null);
  const draw = normalizeR6Match(r6Item(M1, { scores: [3, 3] }, { outcome: 'draw' }));
  assert.equal(draw.result, 'draw');
  const abandon = normalizeR6Match(r6Item(M1, {}, { outcome: 'abandon' }));
  assert.equal(abandon.result, 'loss');
  assert.equal(abandon.outcome, 'abandon');
});

test('client resolves the profile by platform + username, keeps the UUID and the newest match as baseline', async () => {
  const { fetchImpl, calls } = fakeStatsCc({
    '/v2/config': [200, CONFIG],
    '/v2/profiles/pc/Amigo%20R6': [200, { id: PROFILE, username: 'Amigo R6', platform: 'pc' }],
    [`/v2/profiles/${PROFILE}/matches?limit=1`]: [200, [r6Item(M1)]],
  });
  const client = new R6Client({ apiKey: KEY, fetchImpl });
  const { account, baselineMatchId } = await client.resolvePlayer({ platform: 'pc', username: 'Amigo R6' });
  assert.deepEqual(account, { profileId: PROFILE, gameName: 'Amigo R6', platform: 'pc', platformLabel: 'PC' });
  assert.equal(baselineMatchId, M1);
  assert.equal(calls.find(call => call.path === '/v2/config').key, undefined, 'config não leva a chave');
  assert.ok(calls.filter(call => call.path !== '/v2/config').every(call => call.key === KEY));
  assert.deepEqual((await client.platforms()).map(entry => entry.display), ['PC', 'PlayStation', 'Xbox']);
  await assert.rejects(client.resolvePlayer({ platform: 'nintendo', username: 'x' }), /plataforma válida/);
});

test('unknown_profile retries once; hidden_profile and missing_scope get clear messages', async () => {
  let attempts = 0;
  const { fetchImpl } = fakeStatsCc({
    '/v2/config': [200, CONFIG],
    '/v2/profiles/pc/Novo': () => (++attempts === 1 ? [404, { kind: 'unknown_profile', message: 'Profile not found' }] : [200, { id: PROFILE, username: 'Novo' }]),
    '/v2/profiles/pc/Sumido': [404, { kind: 'unknown_profile', message: 'Profile not found' }],
    '/v2/profiles/pc/Oculto': [404, { kind: 'hidden_profile', message: 'Hidden' }],
    '/v2/profiles/pc/SemEscopo': [403, { kind: 'missing_scope', message: 'API key lacks the scope this route needs' }],
    '/v2/profiles/pc/ChaveRuim': [401, { kind: 'unauthorized', message: 'Invalid key' }],
    [`/v2/profiles/${PROFILE}/matches?limit=1`]: [200, []],
  });
  const client = new R6Client({ apiKey: KEY, fetchImpl, unknownRetryMs: 0 });
  const created = await client.resolvePlayer({ platform: 'pc', username: 'Novo' });
  assert.equal(attempts, 2);
  assert.equal(created.baselineMatchId, null);
  await assert.rejects(client.resolvePlayer({ platform: 'pc', username: 'Sumido' }), error => error.kind === 'unknown_profile' && /tente de novo em alguns segundos/.test(error.message));
  await assert.rejects(client.resolvePlayer({ platform: 'pc', username: 'Oculto' }), error => error.kind === 'hidden_profile' && /ocultou este perfil/.test(error.message));
  await assert.rejects(client.resolvePlayer({ platform: 'pc', username: 'SemEscopo' }), error => error.kind === 'missing_scope' && /profiles e matches/.test(error.message) && error.status === 502);
  await assert.rejects(client.resolvePlayer({ platform: 'pc', username: 'ChaveRuim' }), /STATS_CC_API_KEY/);
  await assert.rejects(new R6Client({ fetchImpl }).resolvePlayer({ platform: 'pc', username: 'Novo' }), /Configure STATS_CC_API_KEY/);
});

test('429 and 503 back off: Retry-After blocks the client and RateLimit-Remaining 0 is honoured', async () => {
  let now = 1_000_000;
  const { fetchImpl, calls } = fakeStatsCc({
    [`/v2/profiles/${PROFILE}/matches?limit=20&after=${M1}`]: [429, { kind: 'rate_limited', message: 'Slow down' }, { 'retry-after': '30', 'ratelimit-reset': '30' }],
  });
  const client = new R6Client({ apiKey: KEY, fetchImpl, now: () => now });
  client.config = { platforms: [], maps: {}, ranks: {} };
  client.configLoadedAt = now;
  await assert.rejects(client.newMatches({ profileId: PROFILE, lastSeenMatchId: M1 }), error => error.status === 429 && error.retryAfterMs === 30_000);
  const before = calls.length;
  await assert.rejects(client.newMatches({ profileId: PROFILE, lastSeenMatchId: M1 }), error => error.retryAfterMs === 30_000);
  assert.equal(calls.length, before, 'bloqueado: não chama a API');
  now += 31_000;

  const quota = fakeStatsCc({
    [`/v2/profiles/${PROFILE}/matches?limit=20&after=${M1}`]: [200, [], { 'ratelimit-remaining': '0', 'ratelimit-reset': '12' }],
    [`/v2/profiles/${PROFILE}/matches?limit=20&after=${M2}`]: [503, { kind: 'overloaded', message: 'Busy' }],
  });
  const second = new R6Client({ apiKey: KEY, fetchImpl: quota.fetchImpl, now: () => now });
  second.config = client.config;
  second.configLoadedAt = now;
  assert.deepEqual(await second.newMatches({ profileId: PROFILE, lastSeenMatchId: M1 }), []);
  await assert.rejects(second.newMatches({ profileId: PROFILE, lastSeenMatchId: M1 }), error => error.retryAfterMs === 12_000);
  now += 13_000;
  await assert.rejects(second.newMatches({ profileId: PROFILE, lastSeenMatchId: M2 }), error => error.status === 503 && error.retryAfterMs > 0 && /sobrecarregada/.test(error.message));
});

test('newMatches polls with after, returns oldest first and pages while full', async () => {
  const page1 = Array.from({ length: 20 }, (_, index) => r6Item(`bbbbbbbb-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, {
    ended_at: new Date(Date.parse('2026-11-10T10:00:00Z') + (20 - index) * 60_000).toISOString(),
  }));
  const newest = page1[0].id;
  const { fetchImpl, calls } = fakeStatsCc({
    '/v2/config': [200, CONFIG],
    [`/v2/profiles/${PROFILE}/matches?limit=20&after=${M1}`]: [200, page1],
    [`/v2/profiles/${PROFILE}/matches?limit=20&after=${newest}`]: [200, [r6Item(M3, { ended_at: '2026-11-10T12:00:00Z', playlist: 'quick-match' }), r6Item(M2, { ended_at: '2026-11-10T11:00:00Z', player_summary: null })]],
  });
  const client = new R6Client({ apiKey: KEY, fetchImpl });
  const entries = await client.newMatches({ profileId: PROFILE, lastSeenMatchId: M1 });
  assert.equal(entries.length, 22);
  assert.equal(entries[0].id, page1[19].id, 'mais antiga primeiro');
  assert.equal(entries.at(-1).id, M3);
  assert.equal(entries.at(-1).match, null, 'Partida Rápida é ignorada');
  assert.equal(entries.at(-2).match, null);
  assert.match(entries.at(-2).error, /estatísticas do jogador/, 'item malformado não trava os outros');
  assert.ok(calls.some(call => call.path.includes(`after=${newest}`)));
  await assert.rejects(client.matchesPage('nao-e-uuid'), R6Error);
});
