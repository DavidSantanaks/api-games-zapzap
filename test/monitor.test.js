import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Monitor } from '../src/monitor.js';

const CREATED_AT = '2026-01-01T12:00:00.000Z';
const GROUP = '123456789@g.us';
const silentLogger = { error() {} };

function summary(id, overrides = {}) {
  const sequence = Number(id.match(/\d+$/)?.[0] || 0);
  return {
    id, playerName: 'Amigo#BR1', champion: 'Lulu', kills: 1, deaths: 3, assists: 20,
    cs: 30, gold: 10000, lane: 'SUP', win: true, durationSeconds: 1800,
    endedAt: new Date(Date.parse(CREATED_AT) + (sequence + 1) * 60000).toISOString(),
    queueId: 420, ...overrides,
  };
}

function setup(t, { history = ['BR1_0'], matchImpl, sendImpl } = {}) {
  const store = new Store(':memory:');
  store.updateSettings({ monitoringEnabled: true, whatsappGroupId: GROUP, whatsappGroupName: 'Tropa' });
  const calls = { history: [], details: [], sends: [] };
  const riot = {
    configured: true,
    async matchIds(player, options) {
      calls.history.push({ player, options });
      return typeof history === 'function' ? history(player, options) : history.slice(options.start, options.start + options.count);
    },
    async match(player, id) {
      calls.details.push({ player, id });
      return matchImpl ? matchImpl(player, id) : summary(id, { playerName: `${player.gameName}#${player.tagLine}` });
    },
  };
  const whatsapp = {
    status: () => ({ state: 'connected' }),
    async send(groupId, text, options) {
      calls.sends.push({ groupId, text, ...options });
      return sendImpl?.(groupId, text, options);
    },
  };
  const monitor = new Monitor({ store, riot, whatsapp, logger: silentLogger });
  monitor.stopped = false;
  t.after(async () => { await monitor.close(); store.close(); });
  function addPlayer({ puuid = 'puuid-one', gameName = 'Amigo', cursor = 'BR1_0', enabled = true } = {}) {
    const player = store.addPlayer({ puuid, gameName, tagLine: 'BR1' }, 'americas', cursor);
    return store.updatePlayer(player.id, { createdAt: CREATED_AT, enabled });
  }
  return { store, monitor, riot, whatsapp, calls, addPlayer };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('registration baseline skips all existing match history', async t => {
  const app = setup(t, { history: ['BR1_3', 'BR1_2', 'BR1_1'] });
  const player = app.addPlayer({ cursor: 'BR1_3' });
  await app.monitor.check();
  assert.equal(app.calls.details.length, 0);
  assert.equal(app.calls.sends.length, 0);
  assert.equal(app.store.matches().length, 0);
  assert.equal(app.store.player(player.id).lastSeenMatchId, 'BR1_3');
});

test('players with no baseline still skip matches completed before registration', async t => {
  const app = setup(t, {
    history: ['BR1_old'],
    matchImpl: (_player, id) => summary(id, { endedAt: '2026-01-01T11:00:00.000Z' }),
  });
  const player = app.addPlayer({ cursor: null });
  await app.monitor.check();
  assert.equal(app.store.matches().length, 0);
  assert.equal(app.calls.sends.length, 0);
  assert.equal(app.store.player(player.id).lastSeenMatchId, 'BR1_old');
});

test('new matches send oldest first and subsequent checks do not duplicate them', async t => {
  const app = setup(t, { history: ['BR1_3', 'BR1_2', 'BR1_1', 'BR1_0'] });
  const player = app.addPlayer();
  await app.monitor.check();
  assert.deepEqual(app.calls.details.map(call => call.id), ['BR1_1', 'BR1_2', 'BR1_3']);
  assert.equal(app.calls.sends.length, 3);
  assert.ok(app.calls.sends.every(call => call.groupId === GROUP));
  assert.equal(app.store.player(player.id).lastSeenMatchId, 'BR1_3');
  assert.equal(app.store.stats().sent, 3);
  const sentOrder = app.store.matches().sort((a, b) => a.endedAt.localeCompare(b.endedAt));
  assert.deepEqual(app.calls.sends.map(call => call.text), sentOrder.map(entry => entry.message));
  await app.monitor.check();
  assert.equal(app.calls.details.length, 3);
  assert.equal(app.calls.sends.length, 3);
  assert.equal(app.store.matches().length, 3);
});

test('two tracked players in one Riot match each get a distinct notification', async t => {
  const app = setup(t, { history: ['BR1_1', 'BR1_0'] });
  app.addPlayer({ puuid: 'first', gameName: 'Primeiro' });
  app.addPlayer({ puuid: 'second', gameName: 'Segundo' });
  await app.monitor.check();
  assert.equal(app.store.matches().length, 2);
  assert.equal(app.calls.sends.length, 2);
  assert.equal(new Set(app.calls.sends.map(call => call.messageId)).size, 2);
  assert.deepEqual(new Set(app.store.matches().map(entry => entry.playerName)), new Set(['Primeiro#BR1', 'Segundo#BR1']));
});

test('failed sends persist backoff and reuse the same message ID after monitor recreation', async t => {
  let fail = true;
  const app = setup(t, {
    history: ['BR1_1', 'BR1_0'],
    sendImpl: () => { if (fail) throw new Error('Connection interrupted'); },
  });
  app.addPlayer();
  const before = Date.now();
  await app.monitor.check();
  const failed = app.store.matches()[0];
  assert.equal(failed.status, 'failed');
  assert.equal(failed.attempts, 1);
  assert.equal(failed.error, 'Connection interrupted');
  assert.ok(failed.nextAttemptAt >= before + 60000);
  assert.ok(failed.nextAttemptAt <= Date.now() + 60000);
  assert.equal(app.store.dueDeliveries().length, 0);
  await app.monitor.check();
  assert.equal(app.calls.sends.length, 1, 'backoff must suppress immediate retry');
  fail = false;
  app.store.updateDelivery(failed.id, { nextAttemptAt: 0 });
  const restartedMonitor = new Monitor({ store: app.store, riot: app.riot, whatsapp: app.whatsapp, logger: silentLogger });
  restartedMonitor.stopped = false;
  await restartedMonitor.check();
  await restartedMonitor.close();
  assert.equal(app.calls.sends.length, 2);
  assert.equal(app.calls.sends[0].messageId, app.calls.sends[1].messageId);
  assert.match(app.calls.sends[0].messageId, /^3EB0[0-9A-F]{28}$/);
  const sent = app.store.match(failed.id);
  assert.equal(sent.status, 'sent');
  assert.equal(sent.error, null);
  assert.ok(sent.sentAt);
});

test('match detail failures preserve cursor and resume without replaying already stored matches', async t => {
  let fail = true;
  const app = setup(t, {
    history: ['BR1_3', 'BR1_2', 'BR1_1', 'BR1_0'],
    matchImpl: (_player, id) => {
      if (id === 'BR1_2' && fail) throw new Error('Riot temporarily unavailable');
      return summary(id);
    },
  });
  const player = app.addPlayer();
  await app.monitor.check();
  assert.equal(app.store.player(player.id).lastSeenMatchId, 'BR1_0');
  assert.match(app.store.player(player.id).lastError, /temporarily unavailable/);
  assert.equal(app.store.matches().length, 1);
  assert.equal(app.calls.sends.length, 1);
  fail = false;
  await app.monitor.check();
  assert.equal(app.store.player(player.id).lastSeenMatchId, 'BR1_3');
  assert.equal(app.store.player(player.id).lastError, null);
  assert.equal(app.store.matches().length, 3);
  assert.equal(app.calls.sends.length, 3);
  assert.deepEqual(app.calls.details.map(call => call.id), ['BR1_1', 'BR1_2', 'BR1_2', 'BR1_3']);
});

test('disabled and deleted players never dispatch their queued messages', async t => {
  const app = setup(t, { history: ['BR1_1', 'BR1_0'] });
  const disabled = app.addPlayer({ puuid: 'disabled', enabled: false });
  const removed = app.addPlayer({ puuid: 'removed' });
  app.store.addMatch(disabled, summary('BR1_1'), 'disabled message', GROUP);
  app.store.addMatch(removed, summary('BR1_1'), 'removed message', GROUP);
  app.store.removePlayer(removed.id);
  await app.monitor.check();
  assert.equal(app.calls.history.length, 0);
  assert.equal(app.calls.sends.length, 0);
  const removedEntry = app.store.matches().find(entry => entry.playerId === removed.id);
  assert.equal(removedEntry.status, 'failed');
  assert.match(removedEntry.error, /removido/);
});

test('pausing monitor during an in-flight detail fetch prevents dispatch', async t => {
  const entered = deferred();
  const release = deferred();
  const app = setup(t, {
    history: ['BR1_1', 'BR1_0'],
    matchImpl: async (_player, id) => { entered.resolve(); await release.promise; return summary(id); },
  });
  app.addPlayer();
  const checking = app.monitor.check();
  await entered.promise;
  app.store.updateSettings({ monitoringEnabled: false });
  release.resolve();
  await checking;
  assert.equal(app.calls.sends.length, 0);
  assert.equal(app.monitor.status().running, false);
});

test('deleting a player during an in-flight detail fetch prevents dispatch', async t => {
  const entered = deferred();
  const release = deferred();
  const app = setup(t, {
    history: ['BR1_1', 'BR1_0'],
    matchImpl: async (_player, id) => { entered.resolve(); await release.promise; return summary(id); },
  });
  const player = app.addPlayer();
  const checking = app.monitor.check();
  await entered.promise;
  app.store.removePlayer(player.id);
  release.resolve();
  await checking;
  assert.equal(app.calls.sends.length, 0);
  assert.equal(app.store.player(player.id), null);
});

test('pagination catches up beyond the first 100 matches in chronological order', async t => {
  const history = Array.from({ length: 106 }, (_, index) => `BR1_${105 - index}`);
  const app = setup(t, { history });
  const player = app.addPlayer();
  // Keep delivery disconnected: one cycle deliberately dispatches at most 20 queued entries.
  app.whatsapp.status = () => ({ state: 'disconnected' });
  await app.monitor.check();
  assert.deepEqual(app.calls.history.map(call => call.options.start), [0, 100]);
  assert.equal(app.calls.details.length, 105);
  assert.equal(app.calls.details[0].id, 'BR1_1');
  assert.equal(app.calls.details.at(-1).id, 'BR1_105');
  assert.equal(app.store.stats().matches, 105);
  assert.equal(app.store.player(player.id).lastSeenMatchId, 'BR1_105');
});

test('overlapping checks share one cycle instead of duplicating requests or sends', async t => {
  const entered = deferred();
  const release = deferred();
  const app = setup(t, {
    history: ['BR1_1', 'BR1_0'],
    matchImpl: async (_player, id) => { entered.resolve(); await release.promise; return summary(id); },
  });
  app.addPlayer();
  const first = app.monitor.check();
  await entered.promise;
  const second = app.monitor.check();
  assert.equal(first, second);
  release.resolve();
  await Promise.all([first, second]);
  assert.equal(app.calls.history.length, 1);
  assert.equal(app.calls.details.length, 1);
  assert.equal(app.calls.sends.length, 1);
});
