import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { getDefaultMessageConfig, getLegacyPhrasePools, validateMessageConfig } from '../src/message.js';

test('KDA migration replaces only pristine phrase pools once and preserves authored content and pending messages', t => {
  const directory = mkdtempSync(join(tmpdir(), 'gg-kda-migration-'));
  const filename = join(directory, 'store.sqlite');
  let store = new Store(filename);
  t.after(() => {
    store?.close();
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(filename + suffix)) unlinkSync(filename + suffix);
    rmdirSync(directory);
  });
  const config = getDefaultMessageConfig();
  config.templates[0].text = 'Texto do usuário: {{player}} — KDA {{kda}}\n{{zoeira}}';
  config.phrases = getLegacyPhrasePools();
  config.phrases.support = ['Elogio personalizado para {{nick}}'];
  config.phrases.feed = ['Zoeira personalizada de KDA {{kda}}'];
  store.updateMessageConfig(config);
  const settings = { ...store.settings(), pollIntervalSeconds: 65, whatsappGroupId: '123@g.us' };
  store.updateSettings(settings);
  const player = store.addPlayer({ puuid: 'kda-migration-puuid', gameName: 'Amigo', tagLine: 'BR1' }, 'americas');
  const entry = store.addMatch(player, { id: 'BR1_old', endedAt: '2026-11-06T12:00:00Z' }, 'Texto já na fila', '123@g.us');
  store.db.prepare('DELETE FROM app_migrations WHERE name=?').run('message-kda-bands-v1');
  store.close();
  store = new Store(filename);
  const migrated = store.messageConfig();
  const defaults = getDefaultMessageConfig();
  assert.deepEqual(migrated.phrases.normal, defaults.phrases.normal);
  assert.deepEqual(migrated.phrases.carry, defaults.phrases.carry);
  assert.deepEqual(migrated.phrases.support, config.phrases.support);
  assert.deepEqual(migrated.phrases.feed, config.phrases.feed);
  assert.deepEqual(migrated.templates, config.templates);
  assert.deepEqual(store.settings(), settings);
  assert.equal(store.match(entry.id).message, 'Texto já na fila');
  assert.equal(store.player(player.id).puuid, player.puuid);
  // A later manual choice of an old phrase pool remains an intentional edit.
  migrated.phrases.carry = getLegacyPhrasePools().carry;
  store.updateMessageConfig(migrated);
  store.close();
  store = new Store(filename);
  assert.deepEqual(store.messageConfig(), migrated);
});

test('KDA phrase upgrade keeps a valid long authored template usable instead of blocking startup', t => {
  const directory = mkdtempSync(join(tmpdir(), 'gg-kda-long-template-'));
  const filename = join(directory, 'store.sqlite');
  let store = new Store(filename);
  t.after(() => {
    store?.close();
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(filename + suffix)) unlinkSync(filename + suffix);
    rmdirSync(directory);
  });
  const config = getDefaultMessageConfig();
  config.templates = config.templates.slice(0, 1);
  config.templates[0].text = '{{zoeira}}'.repeat(55);
  config.phrases = getLegacyPhrasePools();
  assert.doesNotThrow(() => validateMessageConfig(config));
  assert.throws(() => validateMessageConfig({ ...config, phrases: getDefaultMessageConfig().phrases }), /10\.000/);
  store.updateMessageConfig(config);
  store.db.prepare('DELETE FROM app_migrations WHERE name=?').run('message-kda-bands-v1');
  store.close();
  store = new Store(filename);
  assert.equal(store.messageConfig().templates[0].text, config.templates[0].text);
  assert.doesNotThrow(() => validateMessageConfig(store.messageConfig()));
  assert.ok(store.db.prepare('SELECT 1 FROM app_migrations WHERE name=?').get('message-kda-bands-v1'));
});
