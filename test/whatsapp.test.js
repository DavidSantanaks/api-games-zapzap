import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WhatsAppClient } from '../src/whatsapp.js';

async function fixture(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'resenha-whatsapp-'));
  const sockets = [];
  const calls = { sends: [], saves: 0, logouts: 0, ends: 0 };
  const deps = {
    pino: () => ({ level: 'silent' }),
    makeCacheableSignalKeyStore: keys => keys,
    Browsers: { ubuntu: name => ['Ubuntu', name, '1.0'] },
    DisconnectReason: { loggedOut: 401, badSession: 500, connectionReplaced: 440, multideviceMismatch: 411, forbidden: 403, restartRequired: 515 },
    qrcode: { toDataURL: async qr => `data:image/png;base64,${qr}` },
    useMultiFileAuthState: async () => ({
      state: { creds: {}, keys: {} },
      saveCreds: async () => { calls.saves++; },
    }),
    makeWASocket: config => {
      const sock = {
        config,
        ev: new EventEmitter(),
        user: { id: '5511999999999:1@s.whatsapp.net' },
        end: () => { calls.ends++; },
        logout: async () => { calls.logouts++; },
        groupFetchAllParticipating: async () => ({
          b: { id: '123-456@g.us', subject: 'Zoeira' },
          a: { id: '789@g.us', subject: 'Amigos' },
          c: { id: '123@s.whatsapp.net', subject: 'Contato' },
        }),
        sendMessage: async (...args) => {
          calls.sends.push(args);
          return { key: { id: args[2].messageId || 'generated-id' }, message: { conversation: args[1].text } };
        },
      };
      sockets.push(sock);
      return sock;
    },
    ...overrides,
  };
  const client = new WhatsAppClient({ authDir: join(dir, 'session'), dependencies: deps });
  t.after(async () => {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { client, sockets, calls, dir };
}

test('start is idempotent and ignores a QR that finishes after connection opens', async t => {
  let resolveQr;
  const { client, sockets } = await fixture(t, {
    qrcode: { toDataURL: () => new Promise(resolve => { resolveQr = resolve; }) },
  });
  await Promise.all([client.start(), client.start()]);
  assert.equal(sockets.length, 1);
  sockets[0].ev.emit('connection.update', { qr: 'private-pairing-value' });
  sockets[0].ev.emit('connection.update', { connection: 'open' });
  resolveQr('data:image/png;base64,qr');
  await Promise.resolve();
  assert.deepEqual(client.status(), { state: 'connected', qrDataUrl: null, phone: '5511999999999', error: null });
  assert.equal(sockets[0].config.syncFullHistory, false);
  assert.equal(sockets[0].ev.listenerCount('messages.upsert'), 0);
});

test('only group destinations can send and the persisted message ID reaches Baileys', async t => {
  const { client, sockets, calls } = await fixture(t);
  await client.start();
  await assert.rejects(client.groups(), /Conecte o WhatsApp/);
  sockets[0].ev.emit('connection.update', { connection: 'open' });
  assert.deepEqual(await client.groups(), [
    { id: '789@g.us', name: 'Amigos' }, { id: '123-456@g.us', name: 'Zoeira' },
  ]);
  await assert.rejects(client.send('5511999999999@s.whatsapp.net', 'Sem envio'), /grupo/);
  assert.equal(calls.sends.length, 0);
  const result = await client.send('789@g.us', 'Jogo: LOL', { messageId: 'MATCH_12345678' });
  assert.deepEqual(result, { messageId: 'MATCH_12345678' });
  assert.deepEqual(calls.sends[0], ['789@g.us', { text: 'Jogo: LOL' }, { messageId: 'MATCH_12345678' }]);
  assert.deepEqual(await sockets[0].config.getMessage({ remoteJid: '789@g.us', id: 'MATCH_12345678' }), { conversation: 'Jogo: LOL' });
});

test('shutdown persists credentials and session; explicit disconnect clears auth', async t => {
  const { client, sockets, calls, dir } = await fixture(t);
  await client.start();
  await writeFile(join(dir, 'session', 'creds.json'), 'saved-session');
  sockets[0].ev.emit('creds.update', {});
  await client.close();
  assert.equal(calls.saves, 1);
  assert.equal(calls.logouts, 0);
  assert.equal(await readFile(join(dir, 'session', 'creds.json'), 'utf8'), 'saved-session');
  assert.equal(sockets[0].ev.listenerCount('connection.update'), 0);
  await client.start();
  await client.disconnect();
  assert.equal(calls.logouts, 1);
  await assert.rejects(readFile(join(dir, 'session', 'creds.json')), { code: 'ENOENT' });
});

test('logout does not reconnect and close cancels a scheduled restart', async t => {
  const { client, sockets } = await fixture(t);
  await client.start();
  sockets[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
  assert.equal(client.status().state, 'disconnected');
  assert.equal(client.reconnectTimer, null);
  await client.start();
  sockets[1].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 515 } } } });
  assert.ok(client.reconnectTimer);
  await client.close();
  assert.equal(client.reconnectTimer, null);
  assert.equal(client.status().state, 'disconnected');
});

test('close while initialization is pending cannot create a late socket', async t => {
  let finishAuth;
  const { client, sockets } = await fixture(t, {
    useMultiFileAuthState: () => new Promise(resolve => { finishAuth = resolve; }),
  });
  const starting = client.start();
  // mkdir completes asynchronously; wait until the fake auth loader has started.
  while (!finishAuth) await new Promise(resolve => setImmediate(resolve));
  const stopping = client.close();
  finishAuth({ state: { creds: {}, keys: {} }, saveCreds: async () => {} });
  await Promise.all([starting, stopping]);
  assert.equal(sockets.length, 0);
  assert.equal(client.status().state, 'disconnected');
});
