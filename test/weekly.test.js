import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { Monitor } from '../src/monitor.js';
import { Store } from '../src/store.js';
import {
  classifyWeek, currentWeeklyWindow, dueWeeklyWindow, getDefaultWeeklyConfig, lastWeeklyWindow,
  renderWeeklyReport, summarizeWeek, validateWeeklyConfig,
} from '../src/weekly.js';

const GROUP = '120000000000000001@g.us';
const HOUR = 60 * 60 * 1000;
const stats = (games, wins, losses, kda = 1, draws = 0) => ({
  playerId: `p-${games}-${wins}`, name: 'Amigo#BR1', games, wins, losses, draws, kills: 0, deaths: 0, assists: 0,
  winrate: wins + losses ? wins / (wins + losses) : null, kda,
});

test('the week closes on Sunday at 21h in São Paulo and windows are contiguous', () => {
  // Domingo, 08/11/2026 21:00 em São Paulo = 09/11 00:00 UTC.
  const sunday21 = Date.parse('2026-11-09T00:00:00.000Z');
  const before = lastWeeklyWindow(sunday21 - 1, {});
  const at = lastWeeklyWindow(sunday21, {});
  assert.equal(before.key, '2026-11-01');
  assert.equal(at.key, '2026-11-08');
  assert.equal(at.end, sunday21);
  assert.equal(at.start, before.end);
  assert.equal(at.period, '02/11 a 08/11');
  assert.equal(currentWeeklyWindow(sunday21 + HOUR, {}).start, sunday21);
  assert.equal(dueWeeklyWindow(sunday21 + 23 * HOUR, {})?.key, '2026-11-08');
  assert.equal(dueWeeklyWindow(sunday21 + 25 * HOUR, {}), null);
  const custom = lastWeeklyWindow(Date.parse('2026-11-11T12:00:00.000Z'), { weeklyDay: 1, weeklyHour: 9 });
  assert.equal(custom.key, '2026-11-09');
  assert.equal(custom.end, Date.parse('2026-11-09T12:00:00.000Z'));
});

test('bands: praise needs 70% wins, 15 games and KDA 3.0 at the same time', () => {
  assert.equal(classifyWeek(stats(2, 2, 0, 9)), 'sumido');
  assert.equal(classifyWeek(stats(0, 0, 0)), 'sumido');
  assert.equal(classifyWeek(stats(10, 3, 7, 3)), 'bagre');
  assert.equal(classifyWeek(stats(10, 4, 6)), 'mediano');
  assert.equal(classifyWeek(stats(20, 10, 10)), 'mediano');
  assert.equal(classifyWeek(stats(20, 11, 9)), 'obrigacao');
  assert.equal(classifyWeek(stats(14, 14, 0, 5)), 'obrigacao', 'poucas partidas não ganham elogio');
  assert.equal(classifyWeek(stats(20, 16, 4, 2.99)), 'obrigacao', 'KDA baixo não ganha elogio');
  assert.equal(classifyWeek(stats(20, 13, 7, 5)), 'obrigacao', '65% já não basta');
  assert.equal(classifyWeek(stats(20, 14, 6, 3)), 'elogio');
  assert.equal(classifyWeek(stats(4, 0, 0, 1, 4)), 'mediano', 'só empates');
});

test('weekly stats ignore draws in the win rate and sum KDA over the week', () => {
  const player = { id: 'a', game: 'cs2', gameName: 'Amigo' };
  const matches = [
    { playerId: 'a', result: 'win', kills: 20, deaths: 10, assists: 5, endedAt: '2026-11-03T00:00:00Z', playerName: 'Amigo' },
    { playerId: 'a', result: 'draw', kills: 10, deaths: 10, assists: 0, endedAt: '2026-11-04T00:00:00Z' },
    { playerId: 'a', result: 'loss', win: false, kills: 5, deaths: 15, assists: 0, endedAt: '2026-11-05T00:00:00Z' },
    { playerId: 'b', result: 'win', kills: 99, deaths: 0, assists: 0 },
  ];
  const [summary] = summarizeWeek([player], matches);
  assert.equal(summary.games, 3);
  assert.deepEqual([summary.wins, summary.losses, summary.draws], [1, 1, 1]);
  assert.equal(summary.winrate, 0.5);
  assert.equal(summary.kda, 40 / 35);
  assert.equal(summary.name, 'Amigo');
});

test('the report ranks players, picks highlight and bagre, and is stable per week', () => {
  const summaries = [
    { ...stats(12, 3, 9, 0.6), playerId: 'ruim', name: 'Ruim#BR1' },
    { ...stats(17, 12, 5, 3.1), playerId: 'bom', name: 'Bom#BR1' },
    { ...stats(1, 1, 0, 2), playerId: 'turista', name: 'Turista#BR1' },
  ];
  const first = renderWeeklyReport({ game: 'lol', summaries, period: '03/11 a 09/11', seed: '2026-11-09' });
  const again = renderWeeklyReport({ game: 'lol', summaries, period: '03/11 a 09/11', seed: '2026-11-09' });
  assert.equal(first.message, again.message);
  assert.deepEqual(first.players.map(player => [player.playerId, player.band]), [['bom', 'elogio'], ['ruim', 'bagre'], ['turista', 'sumido']]);
  assert.match(first.message, /^📅 RESUMO SEMANAL — LOL\nSemana de 03\/11 a 09\/11/);
  assert.match(first.message, /🥇 Bom#BR1 — 17 partidas · 12V 5D \(71%\) · KDA 3,10/);
  assert.match(first.message, /🥈 Ruim#BR1 — 12 partidas · 3V 9D \(25%\)/);
  assert.match(first.message, /💤 Turista#BR1 — 1 partida/);
  assert.match(first.message, /🏆 Destaque: Bom#BR1 \(17 partidas · 12V 5D · KDA 3,10\)\n.+\n\n🐟 Bagre da semana: Ruim#BR1 \(12 partidas · 3V 9D · KDA 0,60\)\n.+$/);
  assert.deepEqual([first.highlight.reason, first.bagre.reason], ['destaque_completo', 'bagre_completo']);
  assert.equal(renderWeeklyReport({ game: 'lol', summaries: [stats(0, 0, 0)], period: 'x', seed: 'x' }), null);
});

test('untouched first-version weekly phrases are upgraded once and edited ones are kept', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'gg-weekly-'));
  const file = join(dir, 'gg.db');
  try {
    new Store(file).close();
    const raw = new DatabaseSync(file);
    const v1 = { ...getDefaultWeeklyConfig(), phrases: { ...getDefaultWeeklyConfig().phrases, elogio: ['Até que jogou direitinho... não se acostuma.'] } };
    raw.prepare('UPDATE weekly_config SET payload=? WHERE id=1').run(JSON.stringify(v1));
    raw.close();
    let store = new Store(file);
    assert.deepEqual(store.weeklyConfig(), v1, 'configuração editada não é trocada');
    store.close();
    const { WEEKLY_CONFIG_V1_FOR_TESTS } = await import('../src/weekly.js');
    const old = new DatabaseSync(file);
    old.prepare('UPDATE weekly_config SET payload=? WHERE id=1').run(JSON.stringify(WEEKLY_CONFIG_V1_FOR_TESTS));
    old.close();
    store = new Store(file);
    assert.deepEqual(store.weeklyConfig(), getDefaultWeeklyConfig());
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('weekly config validation keeps {{ranking}} and blocks {{zoeira}} inside phrases', () => {
  const config = getDefaultWeeklyConfig();
  assert.deepEqual(validateWeeklyConfig(config), config);
  assert.throws(() => validateWeeklyConfig({ ...config, template: 'Sem ranking' }), /ranking/);
  assert.throws(() => validateWeeklyConfig({ ...config, phrases: { ...config.phrases, bagre: ['{{zoeira}}'] } }), /zoeira/);
  assert.throws(() => validateWeeklyConfig({ ...config, line: '{{personagem}}' }), /não permitida/);
  assert.throws(() => validateWeeklyConfig({ ...config, extra: true }), /não permitidos/);
});

function monitorFixture(t, { sendImpl } = {}) {
  const store = new Store(':memory:');
  store.updateSettings({ monitoringEnabled: true, whatsappGroupId: GROUP, whatsappGroupName: 'Tropa' });
  const sends = [];
  // Partidas são detectadas "agora"; o relógio do monitor fica 1h depois do fim da semana atual.
  const week = currentWeeklyWindow(Date.now(), {});
  let clock = week.end + HOUR;
  const riot = { configured: true, matchIds: async () => [], match: async () => null };
  const whatsapp = {
    status: () => ({ state: 'connected' }),
    async send(groupId, text, options) { sends.push({ groupId, text, ...options }); return sendImpl?.(); },
  };
  const monitor = new Monitor({ store, riot, whatsapp, logger: { error() {} }, now: () => clock });
  monitor.stopped = false;
  t.after(async () => { await monitor.close(); store.close(); });
  const addPlayer = (gameName, enabled = true) => {
    const player = store.addPlayer({ puuid: `puuid-${gameName}`, gameName, tagLine: 'BR1' }, 'americas', 'BR1_0');
    return store.updatePlayer(player.id, { createdAt: '2026-01-01T00:00:00.000Z', enabled });
  };
  const addMatches = (player, results) => results.forEach((win, index) => store.addMatch(player, {
    id: `${player.gameName}_${index}`, playerName: `${player.gameName}#BR1`, win, kills: 5, deaths: 5, assists: 5,
    endedAt: new Date().toISOString(),
  }, 'resumo da partida', GROUP));
  return { store, monitor, sends, week, addPlayer, addMatches, setClock: value => { clock = value; } };
}

test('the monitor sends one weekly summary per game and never repeats it', async t => {
  const app = monitorFixture(t);
  const amigo = app.addPlayer('Amigo');
  const pausado = app.addPlayer('Pausado', false);
  app.addMatches(amigo, [true, true, false, true]);
  app.addMatches(pausado, [false, false, false]);
  for (const entry of app.store.dueDeliveries()) app.store.updateDelivery(entry.id, { status: 'sent' });

  app.setClock(app.week.end - 1);
  await app.monitor.check();
  assert.equal(app.sends.length, 0, 'antes do horário não envia');

  app.setClock(app.week.end + HOUR);
  await app.monitor.check();
  await app.monitor.check();
  assert.equal(app.sends.length, 1);
  assert.equal(app.sends[0].groupId, GROUP);
  assert.match(app.sends[0].text, /RESUMO SEMANAL — LOL/);
  assert.match(app.sends[0].text, /Amigo#BR1 — 4 partidas · 3V 1D \(75%\)/);
  assert.doesNotMatch(app.sends[0].text, /Pausado/, 'jogador pausado fica fora');
  assert.match(app.sends[0].messageId, /^3EB0[0-9A-F]{28}$/);

  const reports = app.store.weeklyReports();
  assert.deepEqual(reports.map(report => [report.game, report.status]).sort(), [['cs2', 'skipped'], ['lol', 'sent'], ['r6', 'skipped']]);
  // Um novo monitor (reinício do container) não gera de novo.
  const restarted = new Monitor({ store: app.store, riot: app.monitor.riot, whatsapp: app.monitor.whatsapp, logger: { error() {} }, now: () => app.week.end + 2 * HOUR });
  assert.deepEqual(restarted.generateWeeklyReports(), []);
});

test('weekly summary respects the switch, the 24h tolerance and retries failed sends', async t => {
  let fail = true;
  const app = monitorFixture(t, { sendImpl: () => { if (fail) throw new Error('offline'); } });
  const amigo = app.addPlayer('Amigo');
  app.addMatches(amigo, [true, false, true]);
  app.store.dueDeliveries().forEach(entry => app.store.updateDelivery(entry.id, { status: 'sent' }));

  app.store.updateSettings({ weeklyEnabled: false });
  assert.deepEqual(app.monitor.generateWeeklyReports(), []);
  app.store.updateSettings({ weeklyEnabled: true });
  app.setClock(app.week.end + 25 * HOUR);
  assert.deepEqual(app.monitor.generateWeeklyReports(), [], 'passou de 24 horas');

  app.setClock(app.week.end + HOUR);
  await app.monitor.check();
  const [failed] = app.store.weeklyReports().filter(report => report.game === 'lol');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.attempts, 1);
  fail = false;
  app.setClock(app.week.end + HOUR + 61_000);
  await app.monitor.check();
  assert.equal(app.store.weeklyReport(failed.id).status, 'sent');
  assert.equal(app.sends[0].messageId, app.sends[1].messageId, 'reenvio usa o mesmo ID');
});

test('weekly API: schedule validation, example preview without sending and retry', async t => {
  const store = new Store(':memory:');
  const calls = { sends: 0, refresh: 0 };
  const app = createApp({
    store, riot: { configured: true }, logger: { error() {} },
    whatsapp: { status: () => ({ state: 'connected' }), send: async () => { calls.sends++; } },
    monitor: { status: () => ({}), refresh: () => { calls.refresh++; } },
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(url + path, {
      method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, data: await response.json() };
  };

  const state = await request('/api/weekly');
  assert.equal(state.status, 200);
  assert.deepEqual(state.data.settings, { enabled: true, day: 0, hour: 21 });
  assert.equal(state.data.bands.length, 5);
  assert.equal((await request('/api/weekly/settings', 'PUT', { hour: 24 })).status, 400);
  assert.equal((await request('/api/weekly/settings', 'PUT', { day: '0' })).status, 400);
  const updated = await request('/api/weekly/settings', 'PUT', { enabled: false, day: 6, hour: 20 });
  assert.deepEqual(updated.data.settings, { enabled: false, day: 6, hour: 20 });
  assert.equal(store.settings().weeklyHour, 20);

  const example = await request('/api/weekly/preview', 'POST', { game: 'cs2', source: 'example' });
  assert.equal(example.status, 200);
  assert.match(example.data.message, /RESUMO SEMANAL — CS2/);
  const empty = await request('/api/weekly/preview', 'POST', { game: 'lol', source: 'current' });
  assert.equal(empty.data.empty, true);
  const invalid = await request('/api/weekly/preview', 'POST', { source: 'example', config: { ...getDefaultWeeklyConfig(), template: 'x' } });
  assert.equal(invalid.status, 400);
  assert.equal(calls.sends, 0);

  const config = { ...getDefaultWeeklyConfig(), template: 'Semana {{periodo}}\n{{ranking}}' };
  assert.equal((await request('/api/weekly/config', 'PUT', { config })).data.config.template, config.template);
  assert.equal(store.weeklyConfig().template, config.template);

  const report = store.addWeeklyReport({ game: 'lol', weekKey: '2026-11-08', period: 'p', start: 0, end: 1, message: 'oi', groupId: GROUP });
  assert.equal((await request(`/api/weekly/reports/${report.id}/retry`, 'POST', {})).status, 400);
  store.updateWeeklyReport(report.id, { status: 'failed', attempts: 5 });
  const retried = await request(`/api/weekly/reports/${report.id}/retry`, 'POST', {});
  assert.equal(retried.data.report.status, 'pending');
  assert.equal(retried.data.report.groupId, undefined);
  assert.equal(calls.refresh, 1);
});

test('highlight and bagre come from wins + KDA, each with an acid reason', async () => {
  const { weeklyScore, highlightReason, exampleWeekSummaries } = await import('../src/weekly.js');
  // KDA limitado a 4: metade da nota é a taxa de vitória, metade o KDA.
  assert.equal(weeklyScore({ winrate: 1, kda: 9 }), 1);
  assert.equal(weeklyScore({ winrate: null, kda: 2 }), 0.5);
  const row = (winrate, kda) => ({ winrate, kda });
  assert.equal(highlightReason(row(0.7, 2), 'destaque'), 'destaque_completo');
  assert.equal(highlightReason(row(0.33, 4.6), 'destaque'), 'destaque_kda');
  // Sem mérito, o primeiro é "O menos bagre": venceu carregado, ou perdeu mais sem KDA ≥ 2.
  assert.equal(highlightReason(row(0.75, 0.85), 'destaque'), 'menos_bagre_carona');
  assert.equal(highlightReason(row(0.3, 0.5), 'destaque'), 'menos_bagre_fraco');
  assert.equal(highlightReason(row(0.4, 1.9), 'destaque'), 'menos_bagre_fraco', 'perder mais com KDA < 2 não é destaque');
  assert.equal(highlightReason(row(0.25, 0.6), 'bagre'), 'bagre_completo');
  assert.equal(highlightReason(row(0.3, 1.8), 'bagre'), 'bagre_derrotas');
  assert.equal(highlightReason(row(0.6, 0.7), 'bagre'), 'bagre_carona');
  assert.equal(highlightReason(row(0.6, 1.5), 'bagre'), 'bagre_lanterna');

  // Quem perdeu mais mas teve KDA absurdo passa quem ganhou carregado.
  const report = renderWeeklyReport({ game: 'cs2', summaries: exampleWeekSummaries('cs2'), period: '09/11 a 15/11', seed: 'semana' });
  assert.equal(report.players[0].name, 'Fulano');
  assert.deepEqual(report.highlight, { playerId: 'exemplo-1', reason: 'destaque_kda', title: 'destaque' });
  assert.deepEqual(report.bagre, { playerId: 'exemplo-3', reason: 'bagre_completo', title: 'bagre' });
  assert.match(report.message, /🎮 Grupo: 49 partidas · 23V 26D/);
  assert.match(report.message, /🏆 Destaque: Fulano \(12 partidas · 4V 8D · KDA 4,60\)\n.+/);
  const reasonPool = getDefaultWeeklyConfig().phrases.destaque_kda.map(phrase => phrase.replace(/\{\{\w+\}\}/g, '').slice(0, 12));
  const motivo = report.message.split('\n')[report.message.split('\n').findIndex(line => line.startsWith('🏆')) + 1];
  assert.ok(reasonPool.some(start => motivo.includes(start.trim().slice(0, 8))), 'motivo vem das frases de destaque pelo KDA');

  // Com um só jogador ativo não há bagre nem linha de motivo sobrando.
  const solo = renderWeeklyReport({ game: 'lol', summaries: [{ ...stats(4, 3, 1, 2), playerId: 'a', name: 'Amigo#BR1' }], period: 'x', seed: 'x' });
  assert.equal(solo.bagre, null);
  assert.match(solo.message, /🐟 Bagre da semana: —$/);
  assert.doesNotMatch(solo.message, /\n{3,}/);
});

test('saved weekly configs upgrade additively: pristine v2 becomes v3, edited ones only gain the new pools', async () => {
  const { upgradeWeeklyConfig, WEEKLY_CONFIG_V2_FOR_TESTS } = await import('../src/weekly.js');
  assert.deepEqual(upgradeWeeklyConfig(WEEKLY_CONFIG_V2_FOR_TESTS), getDefaultWeeklyConfig());
  const edited = structuredClone(WEEKLY_CONFIG_V2_FOR_TESTS);
  edited.template = '{{ranking}}\nMeu modelo';
  edited.phrases.bagre = ['Frase minha, {{nick}}.'];
  const upgraded = upgradeWeeklyConfig(edited);
  assert.equal(upgraded.template, '{{ranking}}\nMeu modelo');
  assert.deepEqual(upgraded.phrases.bagre, ['Frase minha, {{nick}}.']);
  assert.deepEqual(upgraded.phrases.destaque_kda, getDefaultWeeklyConfig().phrases.destaque_kda);
  assert.deepEqual(validateWeeklyConfig(upgraded), upgraded);
  const current = getDefaultWeeklyConfig();
  assert.equal(upgradeWeeklyConfig(current), current, 'configuração atual não é regravada');

  // No banco: a configuração editada é atualizada uma vez na inicialização.
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'gg-weekly-v3-'));
  const file = join(dir, 'gg.db');
  try {
    new Store(file).close();
    const raw = new DatabaseSync(file);
    raw.prepare('UPDATE weekly_config SET payload=? WHERE id=1').run(JSON.stringify(edited));
    raw.close();
    const store = new Store(file);
    assert.deepEqual(store.weeklyConfig(), upgraded);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('without merit the top is "O menos bagre" and the bottom "O maior bagre"', async () => {
  const { weeklyStandings } = await import('../src/weekly.js');
  const summaries = [
    { ...stats(12, 9, 3, 0.85), playerId: 'carona', name: 'Carona#BR1' },
    { ...stats(12, 3, 9, 0.6), playerId: 'pior', name: 'Pior#BR1' },
    { ...stats(12, 5, 7, 1.5), playerId: 'meio', name: 'Meio#BR1' },
  ];
  const report = renderWeeklyReport({ game: 'lol', summaries, period: 'x', seed: 'x' });
  assert.match(report.message, /🥴 O menos bagre: Carona#BR1 \(12 partidas · 9V 3D · KDA 0,85\)/);
  assert.match(report.message, /🐡 O maior bagre: Pior#BR1/);
  assert.doesNotMatch(report.message, /🏆 Destaque/);
  const standing = weeklyStandings(summaries);
  assert.equal(standing.merit, false);
  assert.deepEqual(standing.players.map(entry => [entry.playerId, entry.title]), [['carona', 'menos_bagre'], ['meio', null], ['pior', 'maior_bagre']]);
  assert.equal(weeklyStandings([stats(0, 0, 0)]), null);
});

test('weekly standings are stored every closed week, even with the summary off, and feed the hall', async t => {
  const { weeklyHall } = await import('../src/weekly.js');
  const app = monitorFixture(t);
  app.store.updateSettings({ weeklyEnabled: false, whatsappGroupId: '' });
  const amigo = app.addPlayer('Amigo');
  const bagre = app.addPlayer('Bagre');
  app.addMatches(amigo, [true, true, false, true]);
  app.addMatches(bagre, [false, false, false, false]);
  // Uma partida antiga, detectada na semana anterior: a classificação dela também é guardada.
  const old = app.store.addMatch(amigo, { id: 'antiga', playerName: 'Amigo#BR1', win: true, kills: 9, deaths: 1, assists: 0, endedAt: '2026-01-01T00:00:00.000Z' }, 'x', GROUP);
  app.store.updateDelivery(old.id, { createdAt: new Date(app.week.start - 3 * 24 * HOUR).toISOString() });
  for (const entry of app.store.dueDeliveries()) app.store.updateDelivery(entry.id, { status: 'sent' });

  await app.monitor.check();
  await app.monitor.check();
  assert.equal(app.sends.length, 0, 'guardar não envia nada');
  const weeks = app.store.weeklyStandings('lol');
  const current = weeks.find(week => week.weekKey === app.week.key);
  assert.ok(current, 'semana encerrada guardada');
  assert.equal(current.merit, true);
  assert.deepEqual(current.players.map(entry => [entry.name, entry.title, entry.games]), [['Amigo#BR1', 'destaque', 4], ['Bagre#BR1', 'bagre', 4]]);
  const previous = weeks.find(week => week.weekKey !== app.week.key && week.players.length);
  assert.ok(previous, 'semana anterior preenchida a partir das partidas já detectadas');
  assert.equal(new Set(weeks.map(week => week.weekKey)).size, weeks.length, 'sem duplicar semanas');

  const hall = weeklyHall(weeks.filter(week => week.players.length));
  const row = name => hall.find(entry => entry.name === name);
  assert.equal(row('Amigo#BR1').destaque, 1);
  assert.equal(row('Amigo#BR1').sumido, 1, 'na semana antiga jogou só 1 partida');
  assert.equal(row('Amigo#BR1').games, 5);
  assert.equal(row('Bagre#BR1').bagre, 1);
  assert.equal(hall[0].name, 'Amigo#BR1');
});
