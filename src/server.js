import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import pino from 'pino';
import { Store } from './store.js';
import { RiotClient } from './riot.js';
import { Cs2Client } from './cs2.js';
import { WhatsAppClient } from './whatsapp.js';
import { Monitor } from './monitor.js';
import { createApp } from './app.js';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: ['apiKey', 'steamApiKey', 'leetifyApiKey', 'authCode', 'knownCode', 'password', 'qr', 'qrDataUrl'],
});
const dataDir = resolve(process.env.DATA_DIR || './data');
const interval = Number(process.env.POLL_INTERVAL_SECONDS || 120);
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(interval) || interval < 30 || interval > 86400) throw new Error('POLL_INTERVAL_SECONDS precisa estar entre 30 e 86400.');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT inválida.');

const store = new Store(join(dataDir, 'gg-report.sqlite'), { pollIntervalSeconds: interval });
const riot = new RiotClient({ apiKey: process.env.RIOT_API_KEY || '' });
const cs2 = new Cs2Client({
  steamApiKey: process.env.STEAM_API_KEY || '',
  leetifyApiKey: process.env.LEETIFY_API_KEY || '',
});
const whatsapp = new WhatsAppClient({ authDir: join(dataDir, 'whatsapp'), logger });
const monitor = new Monitor({ store, riot, cs2, whatsapp, logger });
const app = createApp({ store, riot, cs2, whatsapp, monitor, password: process.env.APP_PASSWORD || '', logger });
const server = app.listen(port, '0.0.0.0', () => {
  logger.info(`GG Report disponível em http://localhost:${port}`);
  monitor.start();
  // An existing session reconnects automatically; a brand new install waits for the UI.
  if (existsSync(join(dataDir, 'whatsapp', 'creds.json'))) whatsapp.start().catch(error => logger.error({ error: error.message }, 'Não foi possível restaurar o WhatsApp'));
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  const deadline = setTimeout(() => process.exit(1), 27_000);
  deadline.unref();
  server.close();
  await monitor.close();
  await whatsapp.close();
  store.close();
  clearTimeout(deadline);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
