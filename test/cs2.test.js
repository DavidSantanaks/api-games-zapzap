import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Cs2Client, Cs2Error, decodeShareCode, normalizeAuthCode, normalizeCs2Match, normalizeShareCode, normalizeSteamId,
} from '../src/cs2.js';

const STEAM_ID = '76561198034202275';
const AUTH_CODE = '4BK2-9X7QM-8LP3';
const CODE_0 = 'CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK';
const CODE_1 = 'CSGO-CW7Kb-G9p3U-YDKMb-NUZPt-FhnEM';
const CODE_2 = 'CSGO-ruwBY-a8nzc-sf75U-PFq6w-GWRZQ';

function leetifyMatch(overrides = {}, playerOverrides = {}) {
  return {
    id: 'e4519a33-781e-40f2-b668-6631cac4e983',
    finished_at: '2026-11-06T15:00:00.000Z',
    data_source: 'matchmaking',
    data_source_match_id: CODE_1,
    map_name: 'de_dust2',
    team_scores: [
      { team_number: 2, score: 11 },
      { team_number: 3, score: 13 },
    ],
    stats: [
      {
        steam64_id: STEAM_ID,
        name: 'FalleN',
        initial_team_number: 3,
        total_kills: 24,
        total_deaths: 14,
        total_assists: 5,
        dpr: 96.44,
        total_damage: 2314,
        rounds_count: 24,
        rounds_won: 13,
        rounds_lost: 11,
        mvps: 5,
        total_hs_kills: 12,
        ...playerOverrides,
      },
    ],
    ...overrides,
  };
}

test('normalizes SteamID64, auth code and decodes real CS2 match sharing codes', () => {
  assert.equal(normalizeSteamId(` ${STEAM_ID} `), STEAM_ID);
  assert.equal(normalizeSteamId(`https://steamcommunity.com/profiles/${STEAM_ID}/`), STEAM_ID);
  assert.throws(() => normalizeSteamId('12345'), /SteamID64/);
  assert.throws(() => normalizeSteamId('76561190000000000'), /faixa/);

  assert.equal(normalizeAuthCode(' 4bk2-9x7qm-8lp3 '), AUTH_CODE);
  assert.throws(() => normalizeAuthCode('senha-steam'), /formato AAAA-AAAAA-AAAA/);

  const decoded = decodeShareCode(`csgo-${CODE_0.slice(5)}`);
  assert.equal(decoded.code, CODE_0);
  assert.equal(decoded.matchId, 3230642215713767580n);
  assert.equal(decoded.reservationId, 3230647599455273103n);
  assert.equal(decoded.tvPort, 55788);
  assert.equal(normalizeShareCode(CODE_1), CODE_1);
  // Base57 dictionary excludes 0, 1, I, O, g, l.
  assert.equal(decodeShareCode('CSGO-00000-11111-IIIII-OOOOO-lllll'), null);
  assert.throws(() => normalizeShareCode('CSGO-00000-11111-IIIII-OOOOO-lllll'), /código de partida válido/);
});

test('normalizes Premier, Competitive and draw matches while ignoring FACEIT and non-5v5 sources', () => {
  const player = { steamId: STEAM_ID, gameName: 'FalleN' };
  const premier = normalizeCs2Match(leetifyMatch(), player);
  assert.deepEqual(premier, {
    id: CODE_1,
    game: 'cs2',
    leetifyMatchId: 'e4519a33-781e-40f2-b668-6631cac4e983',
    playerName: 'FalleN',
    map: 'de_dust2',
    mode: 'Premier',
    score: '13 x 11',
    result: 'win',
    win: true,
    kills: 24,
    deaths: 14,
    assists: 5,
    adr: 96.4,
    damage: 2314,
    rounds: 24,
    mvps: 5,
    headshotPercent: 50,
    endedAt: '2026-11-06T15:00:00.000Z',
  });

  const competitiveDraw = normalizeCs2Match(leetifyMatch({
    data_source: 'matchmaking_competitive',
    data_source_match_id: CODE_2,
    map_name: 'de_mirage',
    team_scores: [{ team_number: 2, score: 12 }, { team_number: 3, score: 12 }],
  }, { rounds_won: 12, rounds_lost: 12 }), player);
  assert.equal(competitiveDraw.mode, 'Competitivo');
  assert.equal(competitiveDraw.score, '12 x 12');
  assert.equal(competitiveDraw.result, 'draw');
  assert.equal(competitiveDraw.win, null);

  for (const ignored of ['faceit', 'hltv', 'esplay', 'matchmaking_wingman']) {
    assert.equal(normalizeCs2Match(leetifyMatch({ data_source: ignored }), player), null);
  }
});

test('missing optional stats remain null instead of inventing numbers', () => {
  const match = normalizeCs2Match(leetifyMatch({}, {
    dpr: null, total_damage: undefined, mvps: undefined, total_hs_kills: undefined, rounds_count: undefined,
  }), { steamId: STEAM_ID, gameName: 'FalleN' });
  assert.equal(match.adr, null);
  assert.equal(match.damage, null);
  assert.equal(match.mvps, null);
  assert.equal(match.headshotPercent, null);
  assert.equal(match.rounds, 24);
});

test('walks GetNextMatchSharingCode until HTTP 202 and caches 403/412 to prevent Valve 503 bans', async () => {
  const calls = [];
  let mode = 'walk';
  const client = new Cs2Client({
    steamApiKey: 'secret-steam-key-never-leak',
    leetifyApiKey: 'secret-leetify-key-never-leak',
    fetchImpl: async (url, options) => {
      calls.push({ url, headers: options.headers });
      const parsed = new URL(url);
      if (parsed.pathname.includes('GetPlayerSummaries')) {
        return Response.json({ response: { players: [{ steamid: STEAM_ID, personaname: 'Verdadeiro' }] } });
      }
      if (parsed.pathname.includes('GetNextMatchSharingCode')) {
        if (mode === '403') return new Response('{}', { status: 403 });
        if (mode === '412') return new Response('{}', { status: 412 });
        const known = parsed.searchParams.get('knowncode');
        if (known === CODE_0) return Response.json({ result: { nextcode: CODE_1 } }, { status: 200 });
        if (known === CODE_1) return Response.json({ result: { nextcode: CODE_2 } }, { status: 200 });
        return Response.json({ result: { nextcode: 'n/a' } }, { status: 202 });
      }
      if (parsed.pathname.startsWith('/v2/matches/matchmaking/')) {
        assert.equal(options.headers._leetify_key, 'secret-leetify-key-never-leak');
        return Response.json(leetifyMatch({ data_source_match_id: CODE_2 }));
      }
      throw new Error(`Unexpected URL ${url}`);
    },
  });

  const resolved = await client.resolvePlayer({ steamId: STEAM_ID, authCode: AUTH_CODE, knownCode: CODE_0 });
  assert.equal(resolved.gameName, 'Verdadeiro');
  assert.equal(resolved.baselineMatchId, CODE_2, 'registration advances baseline to latest sharing code');

  const codes = await client.walkSharingCodes(STEAM_ID, AUTH_CODE, CODE_0);
  assert.deepEqual(codes, [CODE_1, CODE_2]);

  const detail = await client.matchByShareCode({ steamId: STEAM_ID, gameName: 'Verdadeiro' }, CODE_2);
  assert.equal(detail.state, 'ready');
  assert.equal(detail.match.id, CODE_2);

  mode = '403';
  const beforeSpamCheck = calls.length;
  await assert.rejects(
    client.walkSharingCodes(STEAM_ID, 'BBBB-CCCCC-DDDD', CODE_0),
    error => error instanceof Cs2Error && error.status === 403 && !error.message.includes('secret-steam-key'),
  );
  assert.equal(calls.length, beforeSpamCheck + 1);
  // Repeating the same bad credentials must fail from cache without hitting Steam again.
  await assert.rejects(client.walkSharingCodes(STEAM_ID, 'BBBB-CCCCC-DDDD', CODE_0), /HTTP 403/);
  assert.equal(calls.length, beforeSpamCheck + 1);

  mode = '412';
  await assert.rejects(client.walkSharingCodes(STEAM_ID, AUTH_CODE, 'CSGO-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE'), /HTTP 412/);
  const after412 = calls.length;
  await assert.rejects(client.walkSharingCodes(STEAM_ID, AUTH_CODE, 'CSGO-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE'), /HTTP 412/);
  assert.equal(calls.length, after412);
});

test('handles unindexed demo as pending and respects Steam/Leetify Retry-After rate limits', async () => {
  let leetifyStatus = 500;
  const client = new Cs2Client({
    steamApiKey: 'steam-key',
    fetchImpl: async url => {
      if (url.includes('api.steampowered.com')) {
        return new Response('', { status: 429, headers: { 'retry-after': '12' } });
      }
      if (leetifyStatus === 429) {
        return new Response('', { status: 429, headers: { 'retry-after': '8' } });
      }
      return new Response('Internal Server Error', { status: leetifyStatus });
    },
  });

  const pending500 = await client.matchByShareCode({ steamId: STEAM_ID, gameName: 'Player' }, CODE_1);
  assert.deepEqual(pending500, { state: 'pending' });
  leetifyStatus = 404;
  const pending404 = await client.matchByShareCode({ steamId: STEAM_ID, gameName: 'Player' }, CODE_1);
  assert.deepEqual(pending404, { state: 'pending' });

  await assert.rejects(
    client.walkSharingCodes(STEAM_ID, AUTH_CODE, CODE_0),
    error => error.status === 429 && error.retryAfterMs >= 11_000,
  );
  leetifyStatus = 429;
  await assert.rejects(
    client.recentMatches({ steamId: STEAM_ID }),
    error => error.status === 429 && error.retryAfterMs >= 7_000,
  );
});
