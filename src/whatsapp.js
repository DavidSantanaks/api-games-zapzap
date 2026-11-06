import { mkdir, rm } from 'node:fs/promises';
import { parse, resolve } from 'node:path';

const INITIAL_STATUS = Object.freeze({
  state: 'disconnected', qrDataUrl: null, phone: null, error: null,
});

function timeout(promise, milliseconds, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

async function loadDependencies() {
  const [baileys, qrcode, pino] = await Promise.all([
    import('@whiskeysockets/baileys'), import('qrcode'), import('pino'),
  ]);
  return { ...baileys, makeWASocket: baileys.default, qrcode: qrcode.default, pino: pino.default };
}

/** One linked WhatsApp device. Authentication files belong in a persistent volume. */
export class WhatsAppClient {
  constructor({ authDir, logger, dependencies, getMessage } = {}) {
    if (!authDir || typeof authDir !== 'string') throw new Error('authDir é obrigatório.');
    this.authDir = resolve(authDir);
    if (this.authDir === parse(this.authDir).root || this.authDir === resolve('.')) {
      throw new Error('Use uma subpasta exclusiva para a sessão do WhatsApp.');
    }
    this.logger = logger;
    // A dependency seam keeps lifecycle tests entirely offline.
    this.dependencies = dependencies;
    this.getStoredMessage = getMessage;
    this.current = { ...INITIAL_STATUS };
    this.socket = null;
    this.handlers = null;
    this.enabled = false;
    this.generation = 0;
    this.starting = null;
    this.stopping = null;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.credentialWrites = Promise.resolve();
    this.sentMessages = new Map();
  }

  status() {
    return { ...this.current };
  }

  async start() {
    if (this.stopping) await this.stopping;
    if (this.starting) return this.starting;
    if (this.enabled && (this.socket || this.reconnectTimer)) return this.status();
    this.enabled = true;
    this.current = { ...INITIAL_STATUS, state: 'connecting' };
    const generation = ++this.generation;
    const pending = this.connect(generation).catch(() => {
      if (this.enabled && generation === this.generation) {
        this.current = { ...INITIAL_STATUS, state: 'error', error: 'Não foi possível iniciar o WhatsApp. Tente conectar novamente.' };
        this.enabled = false;
      }
      throw new Error('Não foi possível iniciar o WhatsApp. Confira a pasta de sessão e tente novamente.');
    }).finally(() => {
      if (this.starting === pending) this.starting = null;
    });
    this.starting = pending;
    return pending;
  }

  async connect(generation) {
    this.dependencies ??= await loadDependencies();
    const deps = this.dependencies;
    await mkdir(this.authDir, { recursive: true, mode: 0o700 });
    const { state, saveCreds } = await deps.useMultiFileAuthState(this.authDir);
    if (!this.enabled || generation !== this.generation) return this.status();
    // Library protocol/debug logs can contain keys and private chat data.
    const protocolLogger = deps.pino({ level: 'silent' });
    const sock = deps.makeWASocket({
      auth: {
        creds: state.creds,
        keys: deps.makeCacheableSignalKeyStore(state.keys, protocolLogger),
      },
      logger: protocolLogger,
      browser: deps.Browsers.ubuntu('GG Report'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      shouldIgnoreJid: jid => jid === 'status@broadcast' || jid.endsWith('@newsletter'),
      connectTimeoutMs: 20_000,
      defaultQueryTimeoutMs: 20_000,
      keepAliveIntervalMs: 30_000,
      maxMsgRetryCount: 3,
      getMessage: async key => this.sentMessages.get(`${key.remoteJid}:${key.id}`)
        ?? await this.getStoredMessage?.(key),
    });
    this.socket = sock;
    const onCredentials = () => {
      this.credentialWrites = this.credentialWrites.then(saveCreds).catch(() => {
        if (this.socket === sock) {
          this.current.error = 'Não foi possível salvar a sessão. Confira o volume de dados.';
          this.logger?.error?.('Falha ao persistir a sessão do WhatsApp.');
        }
      });
    };
    const onConnection = update => {
      this.handleConnection(sock, generation, update).catch(() => {
        if (this.socket === sock) this.current.error = 'Não foi possível atualizar a conexão do WhatsApp.';
      });
    };
    this.handlers = { sock, onCredentials, onConnection };
    sock.ev.on('creds.update', onCredentials);
    sock.ev.on('connection.update', onConnection);
    return this.status();
  }

  async handleConnection(sock, generation, { connection, lastDisconnect, qr }) {
    if (!this.enabled || generation !== this.generation || this.socket !== sock) return;
    if (connection === 'close') {
      this.detach(sock);
      const code = lastDisconnect?.error?.output?.statusCode ?? lastDisconnect?.error?.statusCode;
      const reasons = this.dependencies.DisconnectReason;
      const fatal = [reasons.loggedOut, reasons.badSession, reasons.connectionReplaced, reasons.multideviceMismatch, reasons.forbidden].filter(Number.isFinite);
      this.current = { ...INITIAL_STATUS };
      if (fatal.includes(code)) {
        this.enabled = false;
        this.current.error = 'Sessão encerrada ou inválida. Desconecte e leia um novo QR Code.';
      } else {
        this.current.state = 'connecting';
        this.current.error = 'Conexão interrompida. Reconectando automaticamente…';
        this.scheduleReconnect(code === reasons.restartRequired ? 250 : undefined);
      }
      return;
    }
    if (connection === 'open') {
      this.reconnectAttempts = 0;
      const phone = sock.user?.id?.split(':')[0]?.split('@')[0] ?? null;
      this.current = { state: 'connected', qrDataUrl: null, phone, error: null };
      return;
    }
    if (qr) {
      const qrDataUrl = await this.dependencies.qrcode.toDataURL(qr, { margin: 2, width: 300 });
      if (this.enabled && this.socket === sock && generation === this.generation && this.current.state !== 'connected') {
        this.current = { state: 'qr', qrDataUrl, phone: null, error: null };
      }
    }
  }

  scheduleReconnect(delay) {
    if (!this.enabled || this.reconnectTimer) return;
    const wait = delay ?? Math.min(60_000, 1_000 * 2 ** Math.min(this.reconnectAttempts++, 6));
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (!this.enabled) return;
      try {
        // Await outstanding credential persistence before reading the session again.
        await this.credentialWrites;
        if (this.starting) await this.starting;
        if (!this.enabled || this.socket) return;
        const generation = ++this.generation;
        const pending = this.connect(generation).finally(() => {
          if (this.starting === pending) this.starting = null;
        });
        this.starting = pending;
        await pending;
      } catch {
        if (this.enabled) {
          this.current = { ...INITIAL_STATUS, state: 'error', error: 'WhatsApp indisponível. Tentando reconectar…' };
          this.scheduleReconnect();
        }
      }
    }, wait);
    this.reconnectTimer.unref?.();
  }

  detach(sock) {
    if (this.handlers?.sock === sock) {
      sock.ev.off('creds.update', this.handlers.onCredentials);
      sock.ev.off('connection.update', this.handlers.onConnection);
      this.handlers = null;
    }
    if (this.socket === sock) this.socket = null;
  }

  connectedSocket() {
    if (!this.socket || this.current.state !== 'connected') throw new Error('Conecte o WhatsApp antes de continuar.');
    return this.socket;
  }

  async groups() {
    const sock = this.connectedSocket();
    try {
      const groups = await timeout(sock.groupFetchAllParticipating(), 20_000, 'O WhatsApp demorou para listar os grupos. Tente novamente.');
      return Object.values(groups)
        .filter(group => /^[\d-]+@g\.us$/.test(group.id))
        .map(group => ({ id: group.id, name: group.subject || 'Grupo sem nome' }))
        .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    } catch {
      throw new Error('Não foi possível listar os grupos. Confira a conexão do WhatsApp e tente novamente.');
    }
  }

  async send(groupId, text, { messageId } = {}) {
    if (typeof groupId !== 'string' || !/^[\d-]+@g\.us$/.test(groupId)) throw new Error('Selecione um grupo de WhatsApp válido.');
    if (typeof text !== 'string' || !text.trim() || text.length > 10_000) throw new Error('Mensagem inválida.');
    if (messageId !== undefined && !/^[a-zA-Z0-9_-]{8,128}$/.test(messageId)) throw new Error('ID de mensagem inválido.');
    const sock = this.connectedSocket();
    if (messageId) this.remember(groupId, messageId, { conversation: text });
    try {
      const result = await timeout(
        sock.sendMessage(groupId, { text }, messageId ? { messageId } : {}),
        25_000,
        'O WhatsApp demorou para confirmar o envio.',
      );
      if (result?.key?.id && result.message) this.remember(groupId, result.key.id, result.message);
      return { messageId: result?.key?.id ?? messageId ?? null };
    } catch {
      // Fence the old socket so a late response cannot overlap a later retry.
      if (this.socket === sock) {
        this.detach(sock);
        sock.end(new Error('Envio interrompido.'));
        this.current = { ...INITIAL_STATUS, state: 'connecting', error: 'Falha no envio. Reconectando o WhatsApp…' };
        this.scheduleReconnect();
      }
      throw new Error('WhatsApp não confirmou o envio. A mensagem ficará pendente para nova tentativa.');
    }
  }

  remember(groupId, id, message) {
    this.sentMessages.set(`${groupId}:${id}`, message);
    if (this.sentMessages.size > 500) this.sentMessages.delete(this.sentMessages.keys().next().value);
  }

  async close() {
    return this.stop(false);
  }

  async disconnect() {
    return this.stop(true);
  }

  async stop(logout) {
    if (this.stopping) {
      await this.stopping;
      // A disconnect requested during shutdown must still remove the session.
      if (logout) return this.stop(true);
      return this.status();
    }
    this.enabled = false;
    ++this.generation;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const sock = this.socket;
    if (sock) this.detach(sock);
    this.current = { ...INITIAL_STATUS };
    const pending = (async () => {
      if (logout && sock) {
        try { await timeout(sock.logout(), 5_000, 'Tempo de desconexão excedido.'); } catch { /* Clear local auth even if offline. */ }
      }
      if (sock) sock.end(new Error('Conexão encerrada pelo aplicativo.'));
      if (this.starting) await this.starting.catch(() => {});
      await this.credentialWrites;
      if (logout) {
        // authDir is an absolute, dedicated non-root folder validated in the constructor.
        await rm(this.authDir, { recursive: true, force: true });
        this.sentMessages.clear();
      }
      return this.status();
    })().finally(() => {
      if (this.stopping === pending) this.stopping = null;
    });
    this.stopping = pending;
    return pending;
  }
}
