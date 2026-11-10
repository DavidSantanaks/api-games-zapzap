import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Monitor } from '../src/monitor.js';
import { createApp } from '../src/app.js';
import { R6Client } from '../src/r6.js';
import { R6_CREDIT } from '../src/r6-message.js';
import { renderWeeklyReport, summarizeWeek } from '../src/weekly.js';
import { fakeStatsCc, r6Item } from './r6-fixtures.js';

const GROUP = '120000000000000001@g.us';
const KEY = 'chave-ficticia-de-teste';
const PROFILE = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-2222-4333-8444-555555555555';
const BASE = 'aaaaaaaa-0000-4000-8000-000000000001';
const NEW1 = 'aaaaaaaa-0000-4000-8000-000000000002';
const NEW2 = 'aaaaaaaa-0000-4000-8000-000000000003';
const silentLogger = { error() {} };
const CONFIG = { platforms: { pc: { slug: 'pc', display: 'PC' }, xbox: { slug: 'xbox', display: 'Xbox' } }, maps: {}, ranks: {} };
const future = minutes => new Date(Date.now() + minutes * 60_000).toISOString();
const connectedWhatsapp = sends => ({
  status: () => ({ state: 'connected', qrDataUrl: null, phone: null, error: null }),
  groups: async () => [{ id: GROUP, name: 'Resenha' }],
  send: async (groupId, text, options) => { sends.push({ groupId, text, ...options }); },
  start: async () => {},
  disconnect: async () => {},
});

test('HTTP: register an R6 player, reject duplicates, expose state and never leak the key', async t => {
  const store = new Store(':memory:');
  const { fetchImpl } = fakeStatsCc({
    '/v2/config': [200, CONFIG],
    '/v2/profiles/pc/AmigoR6': [200, { id: PROFILE, username: 'AmigoR6' }],
    '/v2/profiles/xbox/OutroNick': [200, { id: PROFILE, username: 'OutroNick' }],
    '/v2/profiles/pc/Oculto': [404, { kind: 'hidden_profile', message: 'Hidden' }],
    [`/v2/profiles/${PROFILE}/matches?limit=1`]: [200, [r6Item(BASE)]],
  });
  const r6 = new R6Client({ apiKey: KEY, fetchImpl, unknownRetryMs: 0 });
  const monitor = { status: () => ({ running: false }), refresh() {}, async check() {} };
  const app = createApp({ store, riot: { configured: false }, r6, whatsapp: connectedWhatsapp([]), monitor, logger: silentLogger });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = async (path, method = 'GET', body) => {
    const response = await fetch(base + path, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, text, data: JSON.parse(text) };
  };

  assert.deepEqual((await req('/api/r6/platforms')).data.platforms.map(entry => entry.slug), ['pc', 'xbox']);
  assert.equal((await req('/api/players', 'POST', { game: 'r6', platform: 'pc', username: '' })).status, 400);
  assert.equal((await req('/api/players', 'POST', { game: 'r6', platform: 'pc', username: 'a/b' })).status, 400);
  const created = await req('/api/players', 'POST', { game: 'r6', platform: 'pc', username: 'AmigoR6' });
  assert.equal(created.status, 201);
  assert.equal(created.data.player.game, 'r6');
  assert.equal(created.data.player.profileId, PROFILE);
  assert.equal(created.data.player.platformLabel, 'PC');
  assert.equal(created.data.player.lastSeenMatchId, undefined);
  assert.equal(store.players('r6')[0].lastSeenMatchId, BASE, 'baseline gravada');
  // Mesmo profile_id com outro nick/plataforma não duplica.
  assert.equal((await req('/api/players', 'POST', { game: 'r6', platform: 'xbox', username: 'OutroNick' })).status, 409);
  const hidden = await req('/api/players', 'POST', { game: 'r6', platform: 'pc', username: 'Oculto' });
  assert.equal(hidden.status, 404);
  assert.match(hidden.data.error, /ocultou este perfil/);

  const state = await req('/api/state');
  assert.equal(state.data.games.r6.configured, true);
  assert.equal(state.data.games.r6.stats.players, 1);
  assert.equal(state.data.r6Configured, true);
  assert.ok(!state.text.includes(KEY), 'a chave nunca vai ao navegador');
  const preview = await req('/api/preview', 'POST', { game: 'r6', scenario: 'carry' });
  assert.equal(preview.data.category, 'carry');
  assert.ok(preview.data.message.endsWith(R6_CREDIT));
  const config = await req('/api/message-config?game=r6');
  assert.ok(config.data.variables.some(variable => variable.key === 'aberturas'));
  assert.equal((await req('/api/message-config?game=lol')).data.variables.some(variable => variable.key === 'aberturas'), false);
});

test('monitor: only new matches are queued, survive a restart without duplicates and stay isolated from LoL', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'gg-r6-'));
  const dbPath = join(dir, 'gg-report.sqlite');
  let store = new Store(dbPath);
  t.after(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
    rmdirSync(dir);
  });
  store.updateSettings({ monitoringEnabled: true, whatsappGroupId: GROUP, whatsappGroupName: 'Resenha' });
  const player = store.addPlayer({ profileId: PROFILE, gameName: 'AmigoR6', platform: 'pc', platformLabel: 'PC' }, 'pc', BASE, 'r6');
  const lol = store.addPlayer({ puuid: 'puuid-ficticio', gameName: 'Amigo', tagLine: 'BR1' }, 'americas', 'BR1_1', 'lol');

  let page = [r6Item(NEW2, { ended_at: future(20), scores: [3, 3] }, { outcome: 'draw', kills: 30, deaths: 2 }), r6Item(NEW1, { ended_at: future(10), playlist: 'quick-match' })];
  const routes = {
    '/v2/config': [200, CONFIG],
    [`/v2/profiles/${PROFILE}/matches?limit=20&after=${BASE}`]: () => [200, page],
    [`/v2/profiles/${PROFILE}/matches?limit=20&after=${NEW2}`]: () => [200, []],
  };
  const { fetchImpl } = fakeStatsCc(routes);
  // LoL limitado (429) não pode bloquear o R6, e vice-versa.
  const riot = {
    configured: true,
    async matchIds() { throw Object.assign(new Error('Limite da Riot atingido.'), { retryAfterMs: 60_000 }); },
  };
  const sends = [];
  const monitor = new Monitor({ store, riot, r6: new R6Client({ apiKey: KEY, fetchImpl }), whatsapp: connectedWhatsapp(sends), logger: silentLogger });
  monitor.stopped = false;
  await monitor.check();

  const queued = store.matches(10, 'r6');
  assert.equal(queued.length, 1, 'Partida Rápida ignorada, empate enviado');
  assert.equal(queued[0].riotMatchId, NEW2);
  assert.equal(queued[0].result, 'draw');
  assert.match(queued[0].message, /EMPATE 🟡/);
  assert.doesNotMatch(queued[0].message, /TÁ, FOI BEM|Quem tava na conta/, 'empate com KDA alto não ganha elogio');
  assert.equal(store.player(player.id).lastSeenMatchId, NEW2);
  assert.equal(store.player(player.id).lastError, null);
  assert.match(store.player(lol.id).lastError, /Riot/);
  assert.equal(sends.length, 1);
  assert.ok(sends[0].text.endsWith(R6_CREDIT));
  assert.equal(store.matches(10, 'lol').length, 0);

  // Reinício: novo Store e Monitor no mesmo banco; a API devolve de novo a mesma página antiga.
  store.close();
  store = new Store(dbPath);
  routes[`/v2/profiles/${PROFILE}/matches?limit=20&after=${NEW2}`] = () => [200, page];
  const again = new Monitor({ store, riot, r6: new R6Client({ apiKey: KEY, fetchImpl }), whatsapp: connectedWhatsapp(sends), logger: silentLogger });
  again.stopped = false;
  await again.check();
  assert.equal(store.matches(10, 'r6').length, 1, 'sem duplicar após reinício');
  assert.equal(sends.length, 1);

  // Semanal: o R6 entra com rótulo e crédito.
  const report = renderWeeklyReport({ game: 'r6', summaries: summarizeWeek(store.players('r6'), store.matches(10, 'r6')), period: '09/11 a 15/11', seed: 'x' });
  assert.match(report.message, /R6/);
  assert.ok(report.message.endsWith(R6_CREDIT));
  page = [];
});

test('monitor: a hidden profile pauses the player and a stats.cc 429 does not block LoL', async () => {
  const store = new Store(':memory:');
  store.updateSettings({ monitoringEnabled: true, whatsappGroupId: GROUP, whatsappGroupName: 'Resenha' });
  store.addPlayer({ puuid: 'puuid-ficticio', gameName: 'Amigo', tagLine: 'BR1' }, 'americas', 'BR1_1', 'lol');
  const limited = store.addPlayer({ profileId: PROFILE, gameName: 'AmigoR6', platform: 'pc', platformLabel: 'PC' }, 'pc', BASE, 'r6');
  const hidden = store.addPlayer({ profileId: OTHER, gameName: 'Sumido', platform: 'pc', platformLabel: 'PC' }, 'pc', BASE, 'r6');
  const { fetchImpl, calls } = fakeStatsCc({
    '/v2/config': [200, CONFIG],
    [`/v2/profiles/${OTHER}/matches?limit=20&after=${BASE}`]: [404, { kind: 'hidden_profile', message: 'Hidden' }],
    [`/v2/profiles/${PROFILE}/matches?limit=20&after=${BASE}`]: [429, { kind: 'rate_limited', message: 'Slow' }, { 'retry-after': '60' }],
  });
  let lolCalls = 0;
  const riot = {
    configured: true,
    async matchIds() { lolCalls++; return ['BR1_1']; },
  };
  const monitor = new Monitor({ store, riot, r6: new R6Client({ apiKey: KEY, fetchImpl }), whatsapp: connectedWhatsapp([]), logger: silentLogger });
  monitor.stopped = false;
  // Ordem do loop: o player mais recente primeiro (oculto, limitado e por fim o LoL). O 429 do R6 não bloqueia o LoL.
  await monitor.check();
  assert.equal(lolCalls, 1, 'LoL consultado mesmo com a stats.cc limitada');
  assert.equal(store.player(hidden.id).enabled, false, 'perfil oculto fica pausado');
  assert.match(store.player(hidden.id).lastError, /ocultou/);
  assert.match(store.player(limited.id).lastError, /Limite de consultas da stats.cc/);
  const before = calls.length;
  await monitor.check();
  assert.equal(calls.filter(call => call.path.includes('/matches')).length, calls.slice(0, before).filter(call => call.path.includes('/matches')).length,
    'durante o Retry-After não consulta de novo e o oculto não é mais consultado');
  assert.equal(lolCalls, 2);
  store.close();
});

test('existing databases gain the R6 message config without touching LoL or CS2 texts', t => {
  const dir = mkdtempSync(join(tmpdir(), 'gg-r6-mig-'));
  const dbPath = join(dir, 'gg-report.sqlite');
  let store = new Store(dbPath);
  t.after(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
    rmdirSync(dir);
  });
  const cs2 = store.messageConfig('cs2');
  cs2.templates[0].text = 'Texto personalizado do CS2 {{zoeira}}';
  store.updateMessageConfig(cs2, 'cs2');
  // Simula uma instalação anterior ao R6.
  store.db.prepare("DELETE FROM game_message_config WHERE game='r6'").run();
  store.close();
  store = new Store(dbPath);
  assert.equal(store.messageConfig('cs2').templates[0].text, 'Texto personalizado do CS2 {{zoeira}}');
  assert.deepEqual(store.messageConfig('r6').templates.map(template => template.id), ['resumo-completo', 'placar-do-grupo', 'pos-game']);
});
