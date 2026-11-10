import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { messagesFor } from '../src/games.js';
import { Store } from '../src/store.js';

test('harsher default phrases replace only untouched categories in LoL and CS2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gg-phrases-'));
  const file = join(dir, 'gg.db');
  try {
    const store = new Store(file);
    const [lolPrevious] = messagesFor('lol').previousPhrasePools();
    const [cs2Previous] = messagesFor('cs2').previousPhrasePools();
    const lol = store.messageConfig('lol');
    store.updateMessageConfig({ ...lol, phrases: { ...lolPrevious, carry: ['Minha frase de elogio, {{nick}}'] } }, 'lol');
    const cs2 = store.messageConfig('cs2');
    store.updateMessageConfig({ ...cs2, phrases: { ...cs2Previous, normal: [...cs2Previous.normal, 'Extra minha'] } }, 'cs2');
    const queued = store.messageConfig('lol').templates;
    store.close();
    const raw = new DatabaseSync(file);
    raw.prepare('DELETE FROM app_migrations WHERE name=?').run('message-acid-phrases-v1');
    raw.close();

    const upgraded = new Store(file);
    const lolDefaults = messagesFor('lol').defaultConfig().phrases;
    const cs2Defaults = messagesFor('cs2').defaultConfig().phrases;
    const lolNow = upgraded.messageConfig('lol');
    const cs2Now = upgraded.messageConfig('cs2');
    assert.deepEqual(lolNow.phrases.feed, lolDefaults.feed);
    assert.deepEqual(lolNow.phrases.support, lolDefaults.support);
    assert.deepEqual(lolNow.phrases.normal, lolDefaults.normal);
    assert.deepEqual(lolNow.phrases.carry, ['Minha frase de elogio, {{nick}}'], 'frase editada fica');
    assert.deepEqual(lolNow.templates, queued, 'modelos não mudam');
    assert.deepEqual(cs2Now.phrases.feed, cs2Defaults.feed);
    assert.deepEqual(cs2Now.phrases.carry, cs2Defaults.carry);
    assert.deepEqual(cs2Now.phrases.normal, [...cs2Previous.normal, 'Extra minha'], 'categoria editada fica');
    upgraded.close();
    // A migração roda uma vez só: voltar ao padrão antigo depois disso é escolha do usuário.
    const again = new Store(file);
    again.updateMessageConfig({ ...again.messageConfig('cs2'), phrases: cs2Previous }, 'cs2');
    again.close();
    const reopened = new Store(file);
    assert.deepEqual(reopened.messageConfig('cs2').phrases, cs2Previous);
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
