import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { Store } from '../src/store.js';

async function fixture(t) {
  const store = new Store(':memory:');
  const calls = { riot: 0, sends: 0, checks: 0 };
  const riot = {
    configured: true,
    async resolvePlayer() { calls.riot++; throw new Error('Unexpected Riot access'); },
    async matchIds() { calls.riot++; throw new Error('Unexpected Riot access'); },
    async match() { calls.riot++; throw new Error('Unexpected Riot access'); },
  };
  const whatsapp = {
    status: () => ({ state: 'disconnected' }),
    async send() { calls.sends++; throw new Error('Unexpected WhatsApp send'); },
  };
  const monitor = { status: () => ({ running: false }), refresh() {}, async check() { calls.checks++; } };
  const app = createApp({ store, riot, whatsapp, monitor, logger: { error() {} } });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  async function request(path, method = 'GET', body) {
    const response = await fetch(base + path, {
      method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  }
  function config(text = 'Modo: {{modo}}\n{{zoeira}}') {
    const draft = store.messageConfig();
    draft.templates = [{ id: 'meu-modelo', name: 'Meu placar', enabled: true, text }];
    for (const category of Object.keys(draft.phrases)) draft.phrases[category] = ['{{nick}} jogou {{modo}}.'];
    return draft;
  }
  function recorded(overrides = {}) {
    const player = store.addPlayer({ puuid: 'fake-player-' + store.players().length, gameName: 'Amigo', tagLine: 'BR1' }, 'americas');
    return store.addMatch(player, {
      id: 'BR1_' + player.id, playerName: 'Amigo#BR1', champion: 'Lulu',
      kills: 1, deaths: 5, assists: 9, cs: 32, gold: 9850, lane: 'SUP', win: false,
      durationSeconds: 1800, endedAt: '2026-11-06T12:30:00.000Z', queueId: 420,
      ...overrides,
    }, 'Texto original da fila', '123456789@g.us');
  }
  return { store, calls, request, config, recorded };
}

test('game-mode field is discoverable and renders a ranked example without saving or external work', async t => {
  const app = await fixture(t);
  const metadata = await app.request('/api/message-config');
  const field = metadata.data.variables.find(variable => variable.key === 'modo');
  assert.ok(field);
  assert.equal(field.label, 'Modo de jogo');
  const before = app.store.messageConfig();
  const draft = app.config();
  const response = await app.request('/api/message-preview', 'POST', { config: draft, scenario: 'feed' });
  assert.equal(response.status, 200);
  assert.equal(response.data.values.modo, 'Ranqueada Solo/Duo');
  assert.match(response.data.message, /Modo: Ranqueada Solo\/Duo/);
  assert.match(response.data.message, /SeuAmigo jogou Ranqueada Solo\/Duo/);
  assert.deepEqual(app.store.messageConfig(), before);
  assert.equal(app.store.matches().length, 0);
  assert.deepEqual(app.calls, { riot: 0, sends: 0, checks: 0 });
});

test('old stored matches derive ARAM from queue ID while leaving their original queued message intact', async t => {
  const app = await fixture(t);
  const stored = app.recorded({ queueId: 450, lane: 'ARAM' });
  assert.equal(stored.gameMode, undefined);
  assert.equal(stored.mode, undefined);
  const before = app.store.match(stored.id);
  const response = await app.request('/api/message-preview', 'POST', { config: app.config(), matchId: stored.id });
  assert.equal(response.status, 200);
  assert.equal(response.data.values.modo, 'ARAM');
  assert.match(response.data.message, /Modo: ARAM/);
  assert.deepEqual(app.store.match(stored.id), before);
  assert.deepEqual(app.calls, { riot: 0, sends: 0, checks: 0 });
});

test('stored-match preview preserves raw gameMode so an unknown queue can use the Riot mode fallback', async t => {
  const app = await fixture(t);
  const stored = app.recorded({ queueId: 999999, gameMode: 'URF' });
  const response = await app.request('/api/message-preview', 'POST', { config: app.config(), matchId: stored.id });
  assert.equal(response.status, 200);
  assert.equal(response.data.match.gameMode, 'URF');
  assert.equal(response.data.values.modo, 'URF');
  assert.match(response.data.message, /Modo: URF/);
  assert.deepEqual(app.calls, { riot: 0, sends: 0, checks: 0 });
});

test('custom saved templates remain authored as-is and may use game mode inside their phrase pools', async t => {
  const app = await fixture(t);
  const config = app.config('Escolhi só estes campos: {{player}}. {{zoeira}}');
  const result = await app.request('/api/message-config', 'PUT', { config });
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.config, config);
  const defaults = await app.request('/api/message-config/defaults');
  assert.equal(defaults.status, 200);
  assert.ok(defaults.data.config.templates.every(template => template.text.includes('{{modo}}')));
  assert.deepEqual(app.store.messageConfig(), config, 'looking up new defaults must not rewrite custom templates');
  const preview = await app.request('/api/message-preview', 'POST', { scenario: 'feed' });
  assert.equal(preview.status, 200);
  assert.match(preview.data.message, /Escolhi só estes campos: SeuAmigo#BR1/);
  assert.match(preview.data.message, /SeuAmigo jogou Ranqueada Solo\/Duo/);
});
