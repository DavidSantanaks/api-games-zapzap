import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { Store } from '../src/store.js';
import { Monitor } from '../src/monitor.js';

const GROUP = '123456789@g.us';
const CREATED_AT = '2026-01-01T12:00:00.000Z';
const clone = value => structuredClone(value);

function matchSummary(id = 'BR1_1', overrides = {}) {
  return {
    id, playerName: 'Amigo#BR1', champion: 'Lulu', kills: 1, deaths: 5, assists: 9,
    cs: 32, gold: 9850, lane: 'SUP', win: false, durationSeconds: 1800,
    endedAt: '2026-01-01T12:30:00.000Z', queueId: 420, ...overrides,
  };
}

async function fixture(t) {
  const store = new Store(':memory:');
  const calls = { history: [], details: [], sends: [], resolve: [] };
  let history = ['BR1_0'];
  let failedSend = false;
  const riot = {
    configured: true,
    async resolvePlayer(query) { calls.resolve.push(query); throw new Error('Unexpected player resolution'); },
    async matchIds(player, options) {
      calls.history.push({ player, options });
      return history.slice(options.start, options.start + options.count);
    },
    async match(player, id) {
      calls.details.push({ player, id });
      return matchSummary(id, { playerName: `${player.gameName}#${player.tagLine}` });
    },
  };
  const whatsapp = {
    status: () => ({ state: 'connected', qrDataUrl: null, phone: null, error: null }),
    async groups() { return [{ id: GROUP, name: 'Tropa' }]; },
    async send(groupId, message, options) {
      calls.sends.push({ groupId, message, ...options });
      if (failedSend) throw new Error('Simulated WhatsApp failure');
    },
  };
  const monitor = new Monitor({ store, riot, whatsapp, logger: { error() {} } });
  monitor.stopped = false;
  monitor.refresh = () => {};
  const app = createApp({ store, riot, whatsapp, monitor, logger: { error() {} } });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await monitor.close();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  async function request(path, method = 'GET', body) {
    const mutation = !['GET', 'HEAD'].includes(method);
    const response = await fetch(`${url}${path}`, {
      method,
      headers: mutation ? { 'Content-Type': 'application/json' } : {},
      ...(mutation ? { body: JSON.stringify(body ?? {}) } : {}),
    });
    return { status: response.status, data: await response.json() };
  }
  function addPlayer() {
    const player = store.addPlayer({ puuid: 'fake-puuid', gameName: 'Amigo', tagLine: 'BR1' }, 'americas', 'BR1_0');
    return store.updatePlayer(player.id, { createdAt: CREATED_AT });
  }
  const config = async () => (await request('/api/message-config')).data.config;
  return {
    store, monitor, calls, request, config, addPlayer,
    setHistory(value) { history = value; },
    setSendFailure(value) { failedSend = value; },
  };
}

function customized(config, text = '{{player}} foi de {{personagem}} na {{lane}}: {{frag}}. {{zoeira}}') {
  const draft = clone(config);
  draft.templates = [{ id: 'personalizada', name: 'Mensagem da tropa', enabled: true, text }];
  draft.phrases = {
    feed: ['{{nick}}, {{deaths}} mortes? O {{personagem}} pediu reembolso KKKK'],
    carry: ['{{nick}} carregou, mas amanhã tem mais.'],
    support: ['{{assists}} assistências: o {{personagem}} trabalhou.'],
    normal: ['Mais uma pra conta de {{player}}.'],
  };
  return draft;
}

test('message editor exposes defaults and a variable catalog without changing existing settings', async t => {
  const app = await fixture(t);
  const settingsBefore = clone(app.store.settings());
  const response = await app.request('/api/message-config');
  assert.equal(response.status, 200);
  assert.equal(response.data.config.templates.length, 3);
  assert.ok(response.data.config.templates.some(template => template.enabled));
  assert.deepEqual(new Set(response.data.categories.map(category => category.key)), new Set(['feed', 'carry', 'support', 'normal']));
  for (const key of ['player', 'lane', 'frag', 'kda', 'personagem', 'farm', 'gold', 'zoeira', 'partida_id']) {
    const variable = response.data.variables.find(variable => variable.key === key);
    assert.ok(variable, `missing ${key}`);
    assert.equal(typeof variable.example, 'string');
  }
  assert.deepEqual(app.store.settings(), settingsBefore);
  assert.equal(app.calls.history.length, 0);
  assert.equal(app.calls.sends.length, 0);
});

test('saving templates and phrase pools persists the configuration and default retrieval does not reset it', async t => {
  const app = await fixture(t);
  const original = await app.config();
  const custom = customized(original);
  const saved = await app.request('/api/message-config', 'PUT', { config: custom });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.data.config, custom);
  assert.deepEqual(await app.config(), custom);
  const defaults = await app.request('/api/message-config/defaults');
  assert.equal(defaults.status, 200);
  assert.deepEqual(defaults.data.config, original);
  assert.deepEqual(await app.config(), custom, 'restoring the draft must not save by itself');
  assert.equal(app.calls.history.length, 0);
  assert.equal(app.calls.sends.length, 0);
});

test('unsaved draft preview expands API fields and phrases without changing records or the saved configuration', async t => {
  const app = await fixture(t);
  const saved = await app.config();
  const draft = customized(saved);
  const settingsBefore = clone(app.store.settings());
  const response = await app.request('/api/message-preview', 'POST', { config: draft, scenario: 'feed', templateId: 'personalizada', phraseIndex: 0 });
  assert.equal(response.status, 200);
  assert.equal(response.data.templateId, 'personalizada');
  assert.equal(response.data.category, 'feed');
  assert.match(response.data.message, /SeuAmigo#BR1 foi de Yasuo na MID: 1\/8\/3/);
  assert.match(response.data.message, /SeuAmigo, 8 mortes\? O Yasuo pediu reembolso/);
  assert.equal(response.data.values.lane, 'MID');
  assert.equal(response.data.values.frag, '1/8/3');
  assert.equal(response.data.values.kda, '0,50');
  assert.equal(response.data.performance.kda, 0.5);
  assert.equal(response.data.performance.band, 'feed');
  assert.deepEqual(await app.config(), saved);
  assert.deepEqual(app.store.settings(), settingsBefore);
  assert.deepEqual(app.store.players(), []);
  assert.deepEqual(app.store.matches(), []);
  assert.deepEqual(app.calls, { history: [], details: [], sends: [], resolve: [] });
});

test('all four sample categories can preview the saved configuration without a draft', async t => {
  const app = await fixture(t);
  const custom = customized(await app.config());
  assert.equal((await app.request('/api/message-config', 'PUT', { config: custom })).status, 200);
  for (const scenario of ['feed', 'carry', 'support', 'normal']) {
    const response = await app.request('/api/message-preview', 'POST', { scenario });
    assert.equal(response.status, 200, scenario);
    assert.equal(response.data.category, scenario);
    assert.equal(response.data.templateId, 'personalizada');
    assert.equal(response.data.match.id, `preview-${scenario}`);
  }
  assert.equal(app.calls.history.length, 0);
  assert.equal(app.calls.sends.length, 0);
});

test('invalid templates and disabled-only variants return 400 and keep the last saved configuration', async t => {
  const app = await fixture(t);
  const original = await app.config();
  const unknownVariable = customized(original, 'Nickname: {{secret_api_key}}');
  const expression = customized(original, '{{ process.exit() }}');
  const disabled = customized(original);
  disabled.templates[0].enabled = false;
  const recursivePhrase = customized(original);
  recursivePhrase.phrases.feed = ['{{zoeira}}'];
  for (const config of [unknownVariable, expression, disabled, recursivePhrase]) {
    const save = await app.request('/api/message-config', 'PUT', { config });
    assert.equal(save.status, 400);
    assert.equal(typeof save.data.error, 'string');
    const preview = await app.request('/api/message-preview', 'POST', { config, scenario: 'feed' });
    assert.equal(preview.status, 400);
    assert.deepEqual(await app.config(), original);
  }
  assert.equal((await app.request('/api/message-config', 'PUT', {})).status, 400);
});

test('preview validates selection options and can explicitly preview a disabled variation', async t => {
  const app = await fixture(t);
  const config = await app.config();
  const disabled = config.templates.find(template => !template.enabled);
  assert.ok(disabled);
  const response = await app.request('/api/message-preview', 'POST', { config, templateId: disabled.id, scenario: 'feed' });
  assert.equal(response.status, 200);
  assert.equal(response.data.templateId, disabled.id);
  for (const body of [
    { scenario: '__proto__' }, { templateId: 'missing' }, { templateId: [] },
    { phraseIndex: -1 }, { phraseIndex: '0' }, { phraseIndex: 999 }, { matchId: [] },
  ]) assert.equal((await app.request('/api/message-preview', 'POST', body)).status, 400, JSON.stringify(body));
  assert.equal((await app.request('/api/message-preview', 'POST', { matchId: 'missing-match' })).status, 404);
});

test('stored-match preview uses the selected real stats and original Riot match ID without touching the queue', async t => {
  const app = await fixture(t);
  const player = app.addPlayer();
  const summary = matchSummary('BR1_stored', { champion: 'Thresh', kills: 4, deaths: 2, assists: 25, lane: 'SUP', win: true });
  const entry = app.store.addMatch(player, summary, 'Already queued snapshot', GROUP);
  const draft = customized(await app.config(), '{{partida_id}} | {{player}} | {{personagem}} | {{frag}} | {{lane}}');
  const before = clone(app.store.matches());
  const response = await app.request('/api/message-preview', 'POST', { config: draft, matchId: entry.id });
  assert.equal(response.status, 200);
  assert.equal(response.data.message, 'BR1_stored | Amigo#BR1 | Thresh | 4/2/25 | SUP');
  assert.equal(response.data.category, 'support');
  assert.equal(response.data.values.partida_id, 'BR1_stored');
  assert.deepEqual(app.store.matches(), before);
  assert.equal(app.calls.history.length, 0);
  assert.equal(app.calls.details.length, 0);
  assert.equal(app.calls.sends.length, 0);
});

test('saved message configuration reaches automatic match processing and retries preserve the queued text', async t => {
  const app = await fixture(t);
  const custom = customized(await app.config());
  assert.equal((await app.request('/api/message-config', 'PUT', { config: custom })).status, 200);
  app.store.updateSettings({ monitoringEnabled: true, whatsappGroupId: GROUP, whatsappGroupName: 'Tropa' });
  app.addPlayer();
  app.setHistory(['BR1_1', 'BR1_0']);
  app.setSendFailure(true);
  await app.monitor.check();
  const failed = app.store.matches()[0];
  assert.equal(failed.status, 'failed');
  assert.match(failed.message, /Amigo#BR1 foi de Lulu na SUP: 1\/5\/9/);
  assert.match(failed.message, /Mais uma pra conta de Amigo#BR1/);
  const replacement = customized(custom, 'NOVO TEXTO PARA AS PRÓXIMAS: {{player}}');
  assert.equal((await app.request('/api/message-config', 'PUT', { config: replacement })).status, 200);
  app.store.updateDelivery(failed.id, { nextAttemptAt: 0 });
  app.setSendFailure(false);
  await app.monitor.check();
  assert.equal(app.calls.sends.length, 2);
  assert.equal(app.calls.sends[0].message, failed.message);
  assert.equal(app.calls.sends[1].message, failed.message);
  assert.equal(app.calls.sends[0].messageId, app.calls.sends[1].messageId);
  assert.equal(app.store.match(failed.id).status, 'sent');
  app.setHistory(['BR1_2', 'BR1_1', 'BR1_0']);
  await app.monitor.check();
  assert.equal(app.calls.sends.at(-1).message, 'NOVO TEXTO PARA AS PRÓXIMAS: Amigo#BR1');
});

test('stored-match KDA chooses roast, obligation and positive pools without rewriting custom text or queued entries', async t => {
  const app = await fixture(t);
  const player = app.addPlayer();
  const draft = customized(await app.config(), 'KDA: {{kda}} | {{zoeira}}');
  draft.phrases = {
    feed: ['ZOEIRA para {{nick}}'],
    normal: ['NÃO FEZ MAIS QUE A OBRIGAÇÃO'],
    carry: ['ELOGIO MODERADO para {{nick}}'],
    support: ['ELOGIO AO SUP com {{assists}} assistências'],
  };
  assert.equal((await app.request('/api/message-config', 'PUT', { config: draft })).status, 200);
  const cases = [
    { kills: 1, deaths: 8, assists: 3, lane: 'SUP', kda: 0.5, category: 'feed', band: 'feed', phrase: 'ZOEIRA para Amigo' },
    { kills: 1, deaths: 5, assists: 9, lane: 'SUP', kda: 2, category: 'normal', band: 'normal', phrase: 'NÃO FEZ MAIS QUE A OBRIGAÇÃO' },
    { kills: 2, deaths: 2, assists: 3, lane: 'MID', kda: 2.5, category: 'normal', band: 'normal', phrase: 'NÃO FEZ MAIS QUE A OBRIGAÇÃO', win: true },
    { kills: 4, deaths: 2, assists: 4, lane: 'MID', kda: 4, category: 'carry', band: 'carry', phrase: 'ELOGIO MODERADO para Amigo', win: true },
    { kills: 4, deaths: 2, assists: 4, lane: 'SUP', kda: 4, category: 'support', band: 'carry', phrase: 'ELOGIO AO SUP com 4 assistências', win: true },
    { kills: 4, deaths: 2, assists: 4, lane: 'MID', kda: 4, category: 'normal', band: 'normal', phrase: 'NÃO FEZ MAIS QUE A OBRIGAÇÃO', win: false },
    { kills: 3, deaths: 0, assists: 1, lane: 'MID', kda: 4, category: 'carry', band: 'carry', phrase: 'ELOGIO MODERADO para Amigo', win: true },
  ];
  for (const [index, sample] of cases.entries()) {
    const { kills, deaths, assists, lane, win = false } = sample;
    const entry = app.store.addMatch(player, matchSummary(`BR1_kda_${index}`, { kills, deaths, assists, lane, win }), 'Texto já registrado na fila', GROUP);
    const before = clone(app.store.match(entry.id));
    const response = await app.request('/api/message-preview', 'POST', { matchId: entry.id });
    assert.equal(response.status, 200);
    assert.equal(response.data.category, sample.category);
    assert.equal(response.data.performance.kda, sample.kda);
    assert.equal(response.data.performance.band, sample.band);
    assert.equal(typeof response.data.performance.label, 'string');
    assert.equal(typeof response.data.performance.range, 'string');
    assert.ok(response.data.message.endsWith(sample.phrase));
    assert.deepEqual(app.store.match(entry.id), before);
  }
  assert.deepEqual(await app.config(), draft);
  assert.deepEqual(app.calls, { history: [], details: [], sends: [], resolve: [] });
});

test('opening a database from before the editor preserves data and saved message edits survive reopening', t => {
  const directory = mkdtempSync(join(tmpdir(), 'gg-report-message-config-'));
  const filename = join(directory, 'legacy.sqlite');
  let store = new Store(filename);
  t.after(() => {
    store?.close();
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(filename + suffix)) unlinkSync(filename + suffix);
    rmdirSync(directory);
  });
  const oldSettings = { pollIntervalSeconds: 75, monitoringEnabled: true, whatsappGroupId: GROUP, whatsappGroupName: 'Tropa' };
  store.updateSettings(oldSettings);
  const player = store.addPlayer({ puuid: 'legacy-puuid', gameName: 'Veterano', tagLine: 'BR1' }, 'americas', 'BR1_0');
  const entry = store.addMatch(player, matchSummary(), 'Old queued text', GROUP);
  store.db.exec('DROP TABLE message_config');
  store.close();
  store = null;
  store = new Store(filename);
  assert.deepEqual(store.settings(), { ...oldSettings, weeklyEnabled: true, weeklyDay: 0, weeklyHour: 21 });
  assert.equal(store.player(player.id).puuid, 'legacy-puuid');
  assert.equal(store.match(entry.id).message, 'Old queued text');
  const draft = customized(store.messageConfig(), 'Persistiu: {{player}} na {{lane}}');
  store.updateMessageConfig(draft);
  store.close();
  store = null;
  store = new Store(filename);
  assert.deepEqual(store.messageConfig(), draft);
  assert.deepEqual(store.settings(), { ...oldSettings, weeklyEnabled: true, weeklyDay: 0, weeklyHour: 21 });
  assert.equal(store.match(entry.id).message, 'Old queued text');
});
