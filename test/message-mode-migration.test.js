import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { getDefaultMessageConfig } from '../src/message.js';

test('mode upgrade updates pristine presets once and preserves authored messages, phrases and queue', t => {
  const directory = mkdtempSync(join(tmpdir(), 'gg-mode-migration-'));
  const filename = join(directory, 'store.sqlite');
  let store = new Store(filename);
  t.after(() => {
    store?.close();
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(filename + suffix)) unlinkSync(filename + suffix);
    rmdirSync(directory);
  });
  const defaults = getDefaultMessageConfig();
  const legacy = structuredClone(defaults);
  for (const template of legacy.templates) template.text = template.text.split('\n').filter(line => line !== 'Modo: {{modo}}').join('\n');
  legacy.templates[0].name = 'Meu nome de modelo';
  legacy.templates[1].text += '\nMinha edição pessoal.';
  legacy.phrases.feed = ['Minha zoeira para {{nick}}'];
  store.updateMessageConfig(legacy);
  const settings = { ...store.settings(), pollIntervalSeconds: 65, whatsappGroupId: '123@g.us' };
  store.updateSettings(settings);
  const player = store.addPlayer({ puuid: 'migration-puuid', gameName: 'Amigo', tagLine: 'BR1' }, 'americas');
  const entry = store.addMatch(player, { id: 'BR1_old', endedAt: '2026-11-06T12:00:00Z' }, 'Texto já na fila', '123@g.us');
  // Represent an installation running before the mode upgrade existed.
  store.db.prepare('DELETE FROM app_migrations WHERE name=?').run('message-presets-mode-v1');
  store.close();
  store = new Store(filename);
  const migrated = store.messageConfig();
  assert.equal(migrated.templates[0].text, defaults.templates[0].text);
  assert.equal(migrated.templates[0].name, 'Meu nome de modelo');
  assert.equal(migrated.templates[1].text, legacy.templates[1].text);
  assert.equal(migrated.templates[2].text, defaults.templates[2].text);
  assert.deepEqual(migrated.phrases, legacy.phrases);
  assert.deepEqual(store.settings(), settings);
  assert.equal(store.player(player.id).puuid, 'migration-puuid');
  assert.equal(store.match(entry.id).message, 'Texto já na fila');
  // Removing mode after upgrading is an intentional user edit, even if it restores the old preset text.
  migrated.templates[0].text = legacy.templates[0].text;
  store.updateMessageConfig(migrated);
  store.close();
  store = new Store(filename);
  assert.equal(store.messageConfig().templates[0].text, legacy.templates[0].text);
  assert.deepEqual(store.messageConfig().phrases, legacy.phrases);
});
