import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Monitor } from '../src/monitor.js';
import { createApp } from '../src/app.js';
import { getDefaultMessageConfig } from '../src/message.js';

const GROUP = '120000000000000001@g.us';
const STEAM_ID = '76561198034202275';
const AUTH_CODE = '4BK2-9X7QM-8LP3';
const BASE_CODE = 'CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK';
const MATCH_CODE_1 = 'CSGO-CW7Kb-G9p3U-YDKMb-NUZPt-FhnEM';
const MATCH_CODE_2 = 'CSGO-ruwBY-a8nzc-sf75U-PFq6w-GWRZQ';
const WINGMAN_CODE = 'CSGO-LjKPL-wZM4k-Bbx4Y-cNywH-mcWoN';
const silentLogger = { error() {} };

function cs2Summary(id, overrides = {}) {
  return {
    id,
    game: 'cs2',
    leetifyMatchId: `lf-${id}`,
    playerName: 'AmigoCS',
    map: 'de_mirage',
    mode: 'Premier',
    score: '13 x 9',
    result: 'win',
    win: true,
    kills: 22,
    deaths: 12,
    assists: 6,
    adr: 94.5,
    damage: 2079,
    rounds: 22,
    mvps: 4,
    headshotPercent: 45,
    endedAt: '2026-11-06T16:00:00.000Z',
    ...overrides,
  };
}

function cleanSqliteDir(dir, dbPath) {
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  rmdirSync(dir);
}

test('additive SQLite migration preserves legacy LoL players, queued messages and custom templates', t => {
  const dir = mkdtempSync(join(tmpdir(), 'gg-cs2-mig-'));
  const dbPath = join(dir, 'gg-report.sqlite');
  let store = null;
  t.after(() => {
    store?.close();
    cleanSqliteDir(dir, dbPath);
  });

  // Create pre-CS2 schema exactly as existing installations have in gg-data.
  const legacyDb = new DatabaseSync(dbPath);
  const customLol = getDefaultMessageConfig();
  customLol.templates = [{ id: 'custom-lol', name: 'Meu LoL', enabled: true, text: 'LoL intacto: {{player}} {{frag}} {{zoeira}}' }];
  legacyDb.exec(`
    CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
    CREATE TABLE message_config (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
    CREATE TABLE app_migrations (name TEXT PRIMARY KEY);
    CREATE TABLE players (id TEXT PRIMARY KEY, identity TEXT NOT NULL UNIQUE, payload TEXT NOT NULL);
    CREATE TABLE matches (
      id TEXT PRIMARY KEY, player_id TEXT NOT NULL, riot_match_id TEXT NOT NULL,
      ended_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
      payload TEXT NOT NULL, UNIQUE(player_id, riot_match_id)
    );
  `);
  legacyDb.prepare('INSERT INTO settings (id,payload) VALUES (1,?)').run(JSON.stringify({
    pollIntervalSeconds: 90, monitoringEnabled: true, whatsappGroupId: GROUP, whatsappGroupName: 'Grupo Antigo',
  }));
  legacyDb.prepare('INSERT INTO message_config (id,payload) VALUES (1,?)').run(JSON.stringify(customLol));
  legacyDb.prepare("INSERT INTO app_migrations(name) VALUES ('message-presets-mode-v1'), ('message-kda-bands-v1')").run();
  legacyDb.prepare('INSERT INTO players (id,identity,payload) VALUES (?,?,?)').run(
    'p-lol-1', 'americas:puuid-legacy',
    JSON.stringify({ id: 'p-lol-1', puuid: 'puuid-legacy', gameName: 'Veterano', tagLine: 'BR1', region: 'americas', enabled: true, createdAt: '2026-01-01T00:00:00Z', lastSeenMatchId: 'BR1_9' })
  );
  legacyDb.prepare('INSERT INTO matches (id,player_id,riot_match_id,ended_at,status,payload) VALUES (?,?,?,?,?,?)').run(
    'm-lol-1', 'p-lol-1', 'BR1_9', '2026-01-02T00:00:00Z', 'pending',
    JSON.stringify({ id: 'm-lol-1', riotMatchId: 'BR1_9', playerId: 'p-lol-1', playerName: 'Veterano#BR1', message: 'Texto original preservado', groupId: GROUP, status: 'pending', attempts: 0, nextAttemptAt: 0, endedAt: '2026-01-02T00:00:00Z' })
  );
  legacyDb.close();

  store = new Store(dbPath);

  assert.equal(store.settings().whatsappGroupName, 'Grupo Antigo');
  assert.deepEqual(store.messageConfig('lol'), customLol);
  assert.equal(store.messageConfig('cs2').templates.length, 3);
  assert.equal(store.players('lol').length, 1);
  assert.equal(store.players('lol')[0].game, 'lol');
  assert.equal(store.players('cs2').length, 0);
  assert.equal(store.match('m-lol-1').message, 'Texto original preservado');
  assert.equal(store.match('m-lol-1').game, 'lol');
  assert.deepEqual(store.stats('lol'), { players: 1, matches: 1, sent: 0, pending: 1 });
  assert.deepEqual(store.stats('cs2'), { players: 0, matches: 0, sent: 0, pending: 0 });
});

test('CS2 monitor handles pending demo analysis, sends Premier/Competitive summaries, and never duplicates after restart', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'gg-cs2-restart-'));
  const dbPath = join(dir, 'gg-report.sqlite');
  let activeStore = null;
  let activeMonitor = null;
  t.after(async () => {
    await activeMonitor?.close();
    activeStore?.close();
    cleanSqliteDir(dir, dbPath);
  });

  let match2Ready = false;
  const sends = [];
  const cs2Mock = {
    configured: true,
    steamConfigured: true,
    leetifyConfigured: true,
    pendingGraceMs: 45 * 60_000,
    async walkSharingCodes(_steamId, _authCode, startCode) {
      const chain = [BASE_CODE, WINGMAN_CODE, MATCH_CODE_1, MATCH_CODE_2];
      const idx = chain.indexOf(startCode);
      return idx >= 0 ? chain.slice(idx + 1) : [];
    },
    async matchByShareCode(_player, code) {
      if (code === WINGMAN_CODE) return { state: 'ignored' };
      if (code === MATCH_CODE_1) return { state: 'ready', match: cs2Summary(MATCH_CODE_1, { mode: 'Premier', endedAt: '2026-11-06T16:10:00.000Z' }) };
      if (code === MATCH_CODE_2) {
        if (!match2Ready) return { state: 'pending' };
        return { state: 'ready', match: cs2Summary(MATCH_CODE_2, { mode: 'Competitivo', map: 'de_inferno', score: '12 x 12', result: 'draw', win: null, endedAt: '2026-11-06T16:50:00.000Z' }) };
      }
      throw new Error(`Unexpected code ${code}`);
    },
  };
  const whatsapp = {
    status: () => ({ state: 'connected' }),
    async send(groupId, text, options) { sends.push({ groupId, text, ...options }); },
  };
  const riot = { configured: false };

  const store1 = new Store(dbPath);
  activeStore = store1;
  store1.updateSettings({ monitoringEnabled: true, whatsappGroupId: GROUP, whatsappGroupName: 'Resenha' });
  const player = store1.addPlayer({
    game: 'cs2', steamId: STEAM_ID, gameName: 'AmigoCS', tagLine: '', authCode: AUTH_CODE, knownCode: BASE_CODE,
  }, 'steam', BASE_CODE, 'cs2');
  store1.updatePlayer(player.id, { createdAt: '2026-11-06T15:00:00.000Z' });

  const monitor1 = new Monitor({ store: store1, riot, cs2: cs2Mock, whatsapp, logger: silentLogger });
  activeMonitor = monitor1;
  monitor1.stopped = false;

  // Cycle 1: Wingman is skipped, Match 1 is sent, Match 2 waits for .dem analysis without advancing past Match 1.
  await monitor1.check();
  assert.equal(sends.length, 1);
  assert.match(sends[0].text, /Jogo: CS2/);
  assert.match(sends[0].text, /Modo: Premier/);
  assert.match(sends[0].text, /Mapa: Mirage/);
  assert.equal(store1.player(player.id).lastSeenMatchId, MATCH_CODE_1);
  assert.equal(store1.player(player.id).pendingShareCode, MATCH_CODE_2);
  assert.match(store1.player(player.id).lastError, /demo/);

  // Cycle 2: Match 2 .dem finishes -> sent with Competitive draw!
  match2Ready = true;
  await monitor1.check();
  assert.equal(sends.length, 2);
  assert.match(sends[1].text, /Modo: Competitivo/);
  assert.match(sends[1].text, /Resultado: EMPATE 🟡/);
  assert.match(sends[1].text, /Placar: 12 x 12/);
  assert.equal(store1.player(player.id).lastSeenMatchId, MATCH_CODE_2);
  assert.equal(store1.player(player.id).lastError, null);

  await monitor1.close();
  store1.close();

  // Simulate container restart on same gg-data SQLite file.
  const store2 = new Store(dbPath);
  activeStore = store2;
  const monitor2 = new Monitor({ store: store2, riot, cs2: cs2Mock, whatsapp, logger: silentLogger });
  activeMonitor = monitor2;
  monitor2.stopped = false;

  await monitor2.check();
  assert.equal(sends.length, 2, 'restarting container must not re-send already processed CS2 matches');
  assert.equal(store2.matches(100, 'cs2').length, 2);
});

test('HTTP API isolates LoL and CS2 configs/players/previews and hides CS2 secrets', async t => {
  const store = new Store(':memory:');
  const riot = {
    configured: false,
    apiKey: 'secret-riot-key',
  };
  const cs2 = {
    configured: true,
    steamConfigured: true,
    leetifyConfigured: true,
    steamApiKey: 'secret-steam-key',
    leetifyApiKey: 'secret-leetify-key',
    async resolvePlayer({ steamId, authCode, knownCode, gameName }) {
      return {
        game: 'cs2',
        steamId,
        gameName: gameName || 'FalleN',
        tagLine: '',
        authCode: authCode ? authCode.toUpperCase() : null,
        knownCode: knownCode || null,
        baselineMatchId: knownCode || MATCH_CODE_1,
      };
    },
    async verifyShareAuth(_steamId, authCode, knownCode) {
      return { authCode: authCode.toUpperCase(), knownCode };
    },
  };
  const whatsapp = {
    status: () => ({ state: 'connected', qrDataUrl: null, phone: '5511999999999', error: null }),
    groups: async () => [{ id: GROUP, name: 'Grupo CS + LoL' }],
    send: async () => {},
    start: async () => {},
    disconnect: async () => {},
  };
  const monitor = {
    status: () => ({ running: false, lastCheckAt: null, nextCheckAt: null, lastError: null }),
    refresh() {},
    async check() {},
  };
  const app = createApp({ store, riot, cs2, whatsapp, monitor, logger: silentLogger });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    store.close();
  });

  async function req(path, method = 'GET', body) {
    const response = await fetch(base + path, {
      method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, text, data: JSON.parse(text) };
  }

  // Register CS2 player with SteamID64 + authCode + knownCode (without needing RIOT_API_KEY!)
  const created = await req('/api/players', 'POST', {
    game: 'cs2',
    steamId: STEAM_ID,
    authCode: '4bk2-9x7qm-8lp3',
    knownCode: BASE_CODE,
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.player.game, 'cs2');
  assert.equal(created.data.player.hasShareAuth, true);
  assert.equal(created.data.player.authCode, undefined);
  assert.equal(created.data.player.knownCode, undefined);
  assert.equal(created.data.player.lastSeenMatchId, undefined);

  // Duplicate SteamID64 rejected with 409
  const duplicate = await req('/api/players', 'POST', { game: 'cs2', steamId: STEAM_ID });
  assert.equal(duplicate.status, 409);

  // Activate monitor with ONLY CS2 configured (no Riot key needed)
  assert.equal((await req('/api/settings', 'PUT', { whatsappGroupId: GROUP })).status, 200);
  assert.equal((await req('/api/settings', 'PUT', { monitoringEnabled: true })).status, 200);

  // Update CS2 share auth via PATCH
  const patched = await req(`/api/players/${created.data.player.id}`, 'PATCH', {
    authCode: AUTH_CODE,
    knownCode: MATCH_CODE_1,
  });
  assert.equal(patched.status, 200);
  assert.equal(store.player(created.data.player.id).lastSeenMatchId, MATCH_CODE_1);

  // State exposes scoped game stats and zero secrets
  const state = await req('/api/state');
  assert.equal(state.status, 200);
  assert.equal(state.data.cs2Configured, true);
  assert.equal(state.data.riotConfigured, false);
  assert.equal(state.data.games.cs2.stats.players, 1);
  assert.equal(state.data.games.lol.stats.players, 0);
  for (const secret of ['secret-steam-key', 'secret-leetify-key', 'secret-riot-key', AUTH_CODE, BASE_CODE, MATCH_CODE_1]) {
    assert.equal(state.text.includes(secret), false, `leaked ${secret}`);
  }

  // Updating CS2 message config never alters LoL message config
  const lolBefore = store.messageConfig('lol');
  const cs2Cfg = (await req('/api/message-config?game=cs2')).data.config;
  cs2Cfg.templates[0].text = 'CS2 customizado: {{player}} em {{mapa}} ({{placar}}) ADR {{adr}} {{zoeira}}';
  const savedCs2 = await req('/api/message-config?game=cs2', 'PUT', { game: 'cs2', config: cs2Cfg });
  assert.equal(savedCs2.status, 200);
  assert.deepEqual(store.messageConfig('lol'), lolBefore);

  const previewCs2 = await req('/api/preview', 'POST', { game: 'cs2', scenario: 'carry' });
  assert.equal(previewCs2.status, 200);
  assert.match(previewCs2.data.message, /CS2 customizado: SeuAmigo em Ancient \(13 x 7\) ADR 112,4/);
});

test('SteamID64-only CS2 player polls recentMatches and Riot 429 does not block CS2 or WhatsApp delivery', async t => {
  const store = new Store(':memory:');
  store.updateSettings({ monitoringEnabled: true, whatsappGroupId: GROUP, whatsappGroupName: 'Tropa' });
  const sends = [];
  const riot = {
    configured: true,
    async matchIds() {
      const err = new Error('Riot rate limited');
      err.retryAfterMs = 60_000;
      throw err;
    },
  };
  const cs2 = {
    configured: true,
    steamConfigured: false,
    leetifyConfigured: true,
    async recentMatches() {
      return [
        cs2Summary(MATCH_CODE_2, { mode: 'Competitivo', map: 'de_anubis', endedAt: '2026-11-06T17:20:00.000Z' }),
        cs2Summary(MATCH_CODE_1, { mode: 'Premier', map: 'de_dust2', endedAt: '2026-11-06T16:40:00.000Z' }),
        cs2Summary(BASE_CODE, { endedAt: '2026-11-06T14:00:00.000Z' }),
      ];
    },
  };
  const whatsapp = {
    status: () => ({ state: 'connected' }),
    async send(groupId, text, options) { sends.push({ groupId, text, ...options }); },
  };
  const monitor = new Monitor({ store, riot, cs2, whatsapp, logger: silentLogger });
  monitor.stopped = false;
  t.after(async () => { await monitor.close(); store.close(); });

  const lolPlayer = store.addPlayer({ puuid: 'lol-1', gameName: 'Invocador', tagLine: 'BR1' }, 'americas', 'BR1_0', 'lol');
  store.updatePlayer(lolPlayer.id, { createdAt: '2026-11-06T15:00:00.000Z' });
  const csPlayer = store.addPlayer({ game: 'cs2', steamId: STEAM_ID, gameName: 'Atirador', tagLine: '', authCode: null, knownCode: null }, 'steam', BASE_CODE, 'cs2');
  store.updatePlayer(csPlayer.id, { createdAt: '2026-11-06T15:00:00.000Z' });

  await monitor.check();
  assert.equal(sends.length, 2, 'CS2 matches still send oldest-first even when Riot hits 429');
  assert.match(sends[0].text, /Mapa: Dust2/);
  assert.match(sends[1].text, /Mapa: Anubis/);
  assert.equal(store.player(csPlayer.id).lastSeenMatchId, MATCH_CODE_2);
  assert.match(store.player(lolPlayer.id).lastError, /rate limited/);
});

