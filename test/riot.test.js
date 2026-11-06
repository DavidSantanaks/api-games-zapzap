import test from 'node:test';
import assert from 'node:assert/strict';
import { RiotClient, RiotError } from '../src/riot.js';

const player = { puuid: 'test-puuid', gameName: 'Seu Amigo', tagLine: 'BR1', region: 'americas' };
function fixture(overrides = {}, participantOverrides = {}) {
  return { info: {
    gameVersion: '16.1.1', gameMode: 'CLASSIC', mapId: 11, queueId: 420,
    gameDuration: 1800, gameStartTimestamp: 1_700_000_000_000,
    gameEndTimestamp: 1_700_001_800_000,
    participants: [{
      puuid: player.puuid, riotIdGameName: 'Amigo Novo', riotIdTagline: 'GG',
      championName: 'Lulu', kills: 1, deaths: 5, assists: 9, totalMinionsKilled: 20,
      neutralMinionsKilled: 4, goldEarned: 10000, teamPosition: 'UTILITY', win: false,
      ...participantOverrides,
    }],
    ...overrides,
  } };
}
function clientWith(data) {
  return new RiotClient({ apiKey: 'secret-key', fetchImpl: async () => Response.json(data) });
}

test('Riot ID resolution uses regional host, encoded path, and key only in headers', async () => {
  const client = new RiotClient({ apiKey: 'secret-key', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://americas.api.riotgames.com/riot/account/v1/accounts/by-riot-id/Name%2F%3F/BR%231');
    assert.equal(options.headers['X-Riot-Token'], 'secret-key');
    assert.ok(!url.includes('secret-key'));
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ puuid: 'resolved', gameName: 'Canonical', tagLine: 'GG' });
  } });
  assert.deepEqual(await client.resolvePlayer({ gameName: 'Name/?', tagLine: 'BR#1', region: 'americas' }),
    { puuid: 'resolved', gameName: 'Canonical', tagLine: 'GG' });
});

test('missing key and invalid host never issue a request', async () => {
  let calls = 0;
  const client = new RiotClient({ fetchImpl: async () => { calls++; } });
  assert.equal(client.configured, false);
  await assert.rejects(client.matchIds(player), /RIOT_API_KEY/);
  await assert.rejects(client.matchIds({ ...player, region: 'malicious.example' }), /Região inválida/);
  assert.equal(calls, 0);
});

test('match history keeps pagination and startTime and caps count at Riot maximum', async () => {
  const client = new RiotClient({ apiKey: 'key', fetchImpl: async url => {
    const parsed = new URL(url);
    assert.equal(parsed.pathname, '/lol/match/v5/matches/by-puuid/test-puuid/ids');
    assert.equal(parsed.searchParams.get('start'), '100');
    assert.equal(parsed.searchParams.get('count'), '100');
    assert.equal(parsed.searchParams.get('startTime'), '1700000000');
    return Response.json(['BR1_123']);
  } });
  assert.deepEqual(await client.matchIds(player, { start: 100, count: 1000, startTime: 1700000000 }), ['BR1_123']);
});

test('normalizes Riot match stats including jungle CS and support role', async () => {
  const match = await clientWith(fixture()).match(player, 'BR1_123');
  assert.deepEqual(match, {
    id: 'BR1_123', playerName: 'Amigo Novo#GG', champion: 'Lulu', kills: 1, deaths: 5,
    assists: 9, cs: 24, gold: 10000, lane: 'SUP', win: false, durationSeconds: 1800,
    endedAt: new Date(1_700_001_800_000).toISOString(), queueId: 420,
    gameMode: 'CLASSIC', mode: 'Ranqueada Solo/Duo',
  });
});

test('uses stored Riot ID and individualPosition when optional current fields are absent', async () => {
  const match = await clientWith(fixture({}, {
    riotIdGameName: undefined, riotIdTagline: undefined, teamPosition: '', individualPosition: 'JUNGLE',
    totalMinionsKilled: undefined, neutralMinionsKilled: 100,
  })).match(player, 'BR1_123');
  assert.equal(match.playerName, 'Seu Amigo#BR1');
  assert.equal(match.lane, 'JG');
  assert.equal(match.cs, 100);
});

test('ARAM is not presented as a normal lane', async () => {
  const match = await clientWith(fixture({ gameMode: 'ARAM', mapId: 12, queueId: 450 })).match(player, 'BR1_aram');
  assert.equal(match.lane, 'ARAM');
  assert.equal(match.gameMode, 'ARAM');
  assert.equal(match.mode, 'ARAM');
});

test('normalizes mode by queue and keeps unknown raw modes without fabricating a queue', async () => {
  const flex = await clientWith(fixture({ queueId: 440 })).match(player, 'BR1_flex');
  assert.equal(flex.gameMode, 'CLASSIC');
  assert.equal(flex.mode, 'Ranqueada Flex');
  const unknown = await clientWith(fixture({ queueId: 999999, gameMode: 'FUTURE_MODE' })).match(player, 'BR1_future');
  assert.equal(unknown.mode, 'FUTURE_MODE');
  const missingQueue = await clientWith(fixture({ queueId: undefined })).match(player, 'BR1_missing');
  assert.equal(missingQueue.queueId, null);
  assert.equal(missingQueue.mode, 'Clássico');
});

test('legacy duration milliseconds become seconds and fallback end timestamp stays correct', async () => {
  const match = await clientWith(fixture({ gameVersion: '11.19.1', gameDuration: 1_800_000, gameEndTimestamp: undefined }))
    .match(player, 'BR1_legacy');
  assert.equal(match.durationSeconds, 1800);
  assert.equal(match.endedAt, new Date(1_700_001_800_000).toISOString());
});

test('custom games are skipped and incomplete or wrong-player matches fail', async () => {
  assert.equal(await clientWith(fixture({ queueId: 0 })).match(player, 'BR1_custom'), null);
  await assert.rejects(clientWith(fixture({}, { puuid: 'another-player' })).match(player, 'BR1_wrong'), /jogador não foi encontrado/);
  await assert.rejects(clientWith(fixture({}, { win: undefined })).match(player, 'BR1_incomplete'), /resultado completo/);
});

test('429 Retry-After blocks subsequent requests without hitting Riot again', async () => {
  let calls = 0;
  const client = new RiotClient({ apiKey: 'key', fetchImpl: async () => {
    calls++;
    return new Response('', { status: 429, headers: { 'Retry-After': '120' } });
  } });
  await assert.rejects(client.matchIds(player), error => error instanceof RiotError && error.status === 429 && error.retryAfterMs === 120000);
  await assert.rejects(client.matchIds(player), error => error.status === 429 && error.retryAfterMs > 119000);
  assert.equal(calls, 1);
});

test('429 accepts an HTTP date and falls back safely if header is malformed', async () => {
  for (const header of [new Date(Date.now() + 120000).toUTCString(), 'bad-value']) {
    const client = new RiotClient({ apiKey: 'key', fetchImpl: async () => new Response('', {
      status: 429, headers: { 'Retry-After': header },
    }) });
    await assert.rejects(client.matchIds(player), error => error.status === 429 && error.retryAfterMs >= 59000 && error.retryAfterMs <= 120000);
  }
});

test('maps auth, not-found, unavailable and network errors without exposing upstream secrets', async () => {
  for (const [status, pattern] of [[401, /chave da API/], [403, /chave da API/], [404, /não encontrado/], [503, /indisponível/]]) {
    const client = new RiotClient({ apiKey: 'secret-key', fetchImpl: async () => new Response('upstream secret-key', { status }) });
    await assert.rejects(client.matchIds(player), error => error.status === status && pattern.test(error.message) && !error.message.includes('secret-key'));
  }
  const client = new RiotClient({ apiKey: 'secret-key', fetchImpl: async () => { throw new Error('secret-key'); } });
  await assert.rejects(client.matchIds(player), error => /conexão/.test(error.message) && !error.message.includes('secret-key'));
});
