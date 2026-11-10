import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { Store } from '../src/store.js';

async function fixture(t, { configured = true, password = '' } = {}) {
  const store = new Store(':memory:');
  const calls = { resolve: [], ids: [], sends: [], groups: 0, refresh: 0, checks: 0, logs: [] };
  const account = { puuid: 'private-puuid-never-expose', gameName: 'Jogador', tagLine: 'BR1' };
  const riot = {
    configured, apiKey: 'private-api-key-never-expose',
    resolvePlayer: async query => { calls.resolve.push(query); return { ...account }; },
    matchIds: async (...args) => { calls.ids.push(args); return ['BR1_baseline']; },
  };
  let whatsappState = 'connected';
  const groupId = '120000000000000001@g.us';
  const whatsapp = {
    status: () => ({ state: whatsappState, qrDataUrl: null, phone: '5511999999999', error: null }),
    groups: async () => { calls.groups++; return [{ id: groupId, name: 'Nome verdadeiro do grupo' }]; },
    send: async (...args) => { calls.sends.push(args); },
    start: async () => { whatsappState = 'connecting'; },
    disconnect: async () => { whatsappState = 'disconnected'; },
  };
  const monitor = {
    status: () => ({ running: false, lastCheckAt: null, nextCheckAt: null, lastError: null }),
    refresh: () => { calls.refresh++; },
    check: async () => { calls.checks++; },
  };
  const app = createApp({ store, riot, whatsapp, monitor, password, logger: { error: (...args) => calls.logs.push(args) } });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  async function request(path, { method = 'GET', body, raw, headers = {} } = {}) {
    const mutation = !['GET', 'HEAD'].includes(method);
    const response = await fetch(`${url}${path}`, {
      method,
      headers: { ...(mutation ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(mutation ? { body: raw ?? JSON.stringify(body ?? {}) } : {}),
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = null; }
    return { status: response.status, headers: response.headers, text, data };
  }
  return { store, riot, whatsapp, monitor, calls, account, groupId, request, url };
}

test('without a Riot key, registration and monitor activation fail before network work', async t => {
  const { request, calls, store } = await fixture(t, { configured: false });
  const registration = await request('/api/players', { method: 'POST', body: { gameName: 'Jogador', tagLine: 'BR1' } });
  assert.equal(registration.status, 400);
  assert.match(registration.data.error, /RIOT_API_KEY/);
  const activation = await request('/api/settings', { method: 'PUT', body: { monitoringEnabled: true } });
  assert.equal(activation.status, 400);
  assert.equal(store.players().length, 0);
  assert.equal(calls.resolve.length, 0);
  assert.equal(calls.sends.length, 0);
});

test('registration resolves trimmed Riot ID, saves a baseline, and rejects duplicates', async t => {
  const { request, calls, store } = await fixture(t);
  const response = await request('/api/players', { method: 'POST', body: { gameName: ' Jogador ', tagLine: ' BR1 ', region: 'americas' } });
  assert.equal(response.status, 201);
  assert.deepEqual(calls.resolve, [{ gameName: 'Jogador', tagLine: 'BR1', region: 'americas' }]);
  assert.equal(calls.ids.length, 1);
  assert.deepEqual(calls.ids[0][1], { count: 1 });
  assert.equal(store.players()[0].lastSeenMatchId, 'BR1_baseline');
  assert.equal(response.data.player.puuid, undefined);
  assert.equal(response.data.player.lastSeenMatchId, undefined);
  assert.equal(store.matches().length, 0);
  const duplicate = await request('/api/players', { method: 'POST', body: { gameName: 'Jogador', tagLine: 'BR1' } });
  assert.equal(duplicate.status, 409);
  assert.equal(store.players().length, 1);
  assert.equal(calls.ids.length, 1);
});

test('group selection requires membership and takes its name from WhatsApp', async t => {
  const { request, store, groupId } = await fixture(t);
  assert.equal((await request('/api/settings', { method: 'PUT', body: { whatsappGroupId: '5511999999999@s.whatsapp.net' } })).status, 400);
  assert.equal((await request('/api/settings', { method: 'PUT', body: { whatsappGroupId: '120000000000000099@g.us' } })).status, 400);
  assert.equal(store.settings().whatsappGroupId, '');
  const result = await request('/api/settings', {
    method: 'PUT', body: { whatsappGroupId: groupId, whatsappGroupName: 'Nome falso enviado pelo cliente' },
  });
  assert.equal(result.status, 200);
  assert.equal(result.data.settings.whatsappGroupName, 'Nome verdadeiro do grupo');
  assert.equal(store.settings().whatsappGroupId, groupId);
});

test('changing an interval preserves the selected group and active monitoring', async t => {
  const { request, store, groupId, calls } = await fixture(t);
  store.updateSettings({ monitoringEnabled: true, whatsappGroupId: groupId, whatsappGroupName: 'Tropa' });
  const result = await request('/api/settings', { method: 'PUT', body: { pollIntervalSeconds: 60 } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.settings, {
    pollIntervalSeconds: 60, monitoringEnabled: true, whatsappGroupId: groupId, whatsappGroupName: 'Tropa',
    weeklyEnabled: true, weeklyDay: 0, weeklyHour: 21,
  });
  assert.equal(calls.groups, 0);
  assert.equal(calls.refresh, 1);
});

test('state keeps Riot secrets and player PUUID private', async t => {
  const { request, store, account, riot } = await fixture(t);
  store.addPlayer(account, 'americas', 'BR1_private_cursor');
  const state = await request('/api/state');
  assert.equal(state.status, 200);
  assert.equal(state.data.riotConfigured, true);
  assert.equal(state.data.players.length, 1);
  for (const secret of [account.puuid, riot.apiKey, 'BR1_private_cursor']) assert.equal(state.text.includes(secret), false);
  assert.equal(state.headers.get('cache-control'), 'no-store');
});

test('cross-origin mutations are blocked and same-origin JSON updates work', async t => {
  const { request, store, url } = await fixture(t);
  const blocked = await request('/api/settings', { method: 'PUT', headers: { Origin: 'https://attacker.example' }, body: { pollIntervalSeconds: 60 } });
  assert.equal(blocked.status, 403);
  assert.equal(store.settings().pollIntervalSeconds, 120);
  const allowed = await request('/api/settings', { method: 'PUT', headers: { Origin: url }, body: { pollIntervalSeconds: 90 } });
  assert.equal(allowed.status, 200);
  assert.equal(store.settings().pollIntervalSeconds, 90);
});

test('API rejects malformed JSON, non-object bodies, and invalid field types', async t => {
  const { request, store } = await fixture(t);
  for (const raw of ['{', 'null', '[]', '"text"', 'true']) {
    const response = await request('/api/settings', { method: 'PUT', raw });
    assert.equal(response.status, 400, `payload ${JSON.stringify(raw)}: ${response.status} ${response.text}`);
  }
  for (const body of [{ pollIntervalSeconds: '60' }, { pollIntervalSeconds: 0 }, { monitoringEnabled: 'true' }, { whatsappGroupId: 123 }]) {
    assert.equal((await request('/api/settings', { method: 'PUT', body })).status, 400);
  }
  assert.equal((await request('/api/players', { method: 'POST', body: { gameName: 12, tagLine: 'BR1' } })).status, 400);
  assert.equal((await request('/api/players', { method: 'POST', body: { gameName: 'Nick', tagLine: [] } })).status, 400);
  assert.equal((await request('/api/players', { method: 'POST', raw: '' })).status, 400);
  assert.equal((await request('/api/preview', { method: 'POST', raw: '' })).status, 400);
  assert.equal(store.settings().pollIntervalSeconds, 120);
});

test('optional Basic authentication protects static content and API', async t => {
  const password = 'local-test-password';
  const { request } = await fixture(t, { password });
  for (const path of ['/', '/app.js', '/api/state']) {
    const denied = await request(path);
    assert.equal(denied.status, 401, path);
    assert.match(denied.headers.get('www-authenticate'), /Basic/);
  }
  const wrong = { Authorization: `Basic ${Buffer.from('admin:wrong').toString('base64')}` };
  assert.equal((await request('/api/state', { headers: wrong })).status, 401);
  const correct = { Authorization: `Basic ${Buffer.from(`admin:${password}`).toString('base64')}` };
  assert.equal((await request('/api/state', { headers: correct })).status, 200);
  assert.equal((await request('/', { headers: correct })).status, 200);
  assert.equal((await request('/health')).status, 200);
});

test('preview produces example text without persisting, checking Riot, or sending', async t => {
  const { request, store, calls } = await fixture(t, { configured: false });
  const expectedKda = { feed: 0.5, normal: 2, carry: 11.5, support: 25 / 3 };
  for (const scenario of ['feed', 'normal', 'carry', 'support']) {
    const result = await request('/api/preview', { method: 'POST', body: { scenario } });
    assert.equal(result.status, 200);
    assert.match(result.data.message, /Jogo: LOL/);
    assert.equal(result.data.match.id, `preview-${scenario}`);
    assert.equal(result.data.category, scenario);
    assert.equal(result.data.performance.kda, expectedKda[scenario]);
    assert.equal(result.data.performance.band, scenario === 'support' ? 'carry' : scenario);
  }
  assert.equal((await request('/api/preview', { method: 'POST', body: { scenario: '__proto__' } })).status, 400);
  assert.equal(store.matches().length, 0);
  assert.equal(store.players().length, 0);
  assert.equal(calls.resolve.length, 0);
  assert.equal(calls.sends.length, 0);
  assert.equal(calls.checks, 0);
});

test('deleting a player cancels its pending deliveries and disables manual retry', async t => {
  const { request, store, account, groupId, calls } = await fixture(t);
  const player = store.addPlayer(account, 'americas');
  const match = store.addMatch(player, {
    id: 'BR1_pending', endedAt: new Date().toISOString(), playerName: 'Jogador#BR1',
    champion: 'Lulu', kills: 1, deaths: 5, assists: 9, cs: 24, gold: 9000, lane: 'SUP', win: false,
  }, 'Resumo pendente', groupId);
  assert.equal(store.dueDeliveries().length, 1);
  assert.equal((await request(`/api/players/${player.id}`, { method: 'DELETE' })).status, 200);
  assert.equal(store.player(player.id), null);
  assert.equal(store.dueDeliveries().length, 0);
  assert.equal(store.match(match.id).status, 'failed');
  assert.match(store.match(match.id).error, /removido/);
  assert.equal((await request(`/api/matches/${match.id}/retry`, { method: 'POST' })).status, 400);
  assert.equal(calls.sends.length, 0);
});
