import { createHash } from 'node:crypto';
import { formatMessage } from './message.js';
import { messagesFor } from './games.js';

const RIOT_MISSING = 'Configure RIOT_API_KEY no arquivo .env. No Docker, aplique com: docker compose up -d --force-recreate. Na execução local, reinicie o app.';
const CS2_MISSING = 'Configure STEAM_API_KEY (e opcionalmente LEETIFY_API_KEY) no arquivo .env. No Docker, aplique com: docker compose up -d --force-recreate. Na execução local, reinicie o app.';

export class Monitor {
  constructor({ store, riot, cs2 = null, whatsapp, logger = console }) {
    Object.assign(this, { store, riot, cs2, whatsapp, logger });
    this.running = false;
    this.lastCheckAt = null;
    this.lastError = null;
    this.nextCheckAt = null;
    this.timer = null;
    this.stopped = true;
    this.inFlight = null;
  }
  status() {
    return { running: this.running, lastCheckAt: this.lastCheckAt, lastError: this.lastError, nextCheckAt: this.nextCheckAt };
  }
  start() { this.stopped = false; this.schedule(1000); }
  schedule(delay) {
    clearTimeout(this.timer);
    if (this.stopped) return;
    const active = this.store.settings().monitoringEnabled;
    this.nextCheckAt = active ? new Date(Date.now() + delay).toISOString() : null;
    this.timer = setTimeout(() => {
      this.check().catch(error => this.logger.error({ err: error.message }, 'Falha no monitor'))
        .finally(() => this.schedule(this.store.settings().pollIntervalSeconds * 1000));
    }, delay);
    this.timer.unref?.();
  }
  refresh() { this.schedule(500); }
  check() {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.cycle().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
  async cycle() {
    if (!this.store.settings().monitoringEnabled) return;
    this.running = true;
    this.lastError = null;
    try {
      const enabledPlayers = this.store.players().filter(player => player.enabled);
      if (!enabledPlayers.length && !this.riot?.configured && !this.cs2?.configured) {
        throw new Error(RIOT_MISSING);
      }
      const rateLimited = new Set();
      for (const player of enabledPlayers) {
        if (this.stopped || !this.store.settings().monitoringEnabled) break;
        const game = player.game || 'lol';
        if (rateLimited.has(game)) continue;
        try {
          if (game === 'cs2') {
            if (!this.cs2?.configured) throw new Error(CS2_MISSING);
            await this.checkCs2Player(player);
          } else {
            if (!this.riot?.configured) throw new Error(RIOT_MISSING);
            await this.checkPlayer(player);
          }
          if (this.store.player(player.id)) this.store.updatePlayer(player.id, { lastCheckedAt: new Date().toISOString(), lastError: null });
        } catch (error) {
          if (this.store.player(player.id)) this.store.updatePlayer(player.id, { lastCheckedAt: new Date().toISOString(), lastError: error.message });
          this.lastError = error.message;
          if (error.retryAfterMs > 0) rateLimited.add(game);
        }
      }
      await this.deliver();
    } catch (error) {
      this.lastError = error.message;
    } finally {
      this.lastCheckAt = new Date().toISOString();
      this.running = false;
    }
  }
  async checkPlayer(player) {
    let newestId;
    const unseen = [];
    let foundCursor = false;
    // Paginate to catch up after downtime; never silently advance past a truncated history.
    for (let start = 0; start < 1000; start += 100) {
      const ids = await this.riot.matchIds(player, {
        start, count: 100, startTime: Math.floor(Date.parse(player.createdAt) / 1000) - 86400,
      });
      if (!newestId && ids.length) newestId = ids[0];
      for (const id of ids) {
        if (id === player.lastSeenMatchId) { foundCursor = true; break; }
        unseen.push(id);
      }
      if (foundCursor || ids.length < 100) break;
      if (start === 900) throw new Error('Mais de 1.000 partidas pendentes. Não avancei o histórico para evitar perda de partidas.');
    }
    for (const id of unseen.reverse()) {
      const currentPlayer = this.store.player(player.id);
      if (!currentPlayer?.enabled || this.stopped || !this.store.settings().monitoringEnabled) return;
      if (this.store.hasMatch(player.id, id)) continue;
      const match = await this.riot.match(player, id);
      if (!this.store.player(player.id)?.enabled || this.stopped || !this.store.settings().monitoringEnabled) return;
      if (!match || Date.parse(match.endedAt) <= Date.parse(player.createdAt)) continue;
      const { message } = formatMessage(match, { config: this.store.messageConfig('lol') });
      this.store.addMatch(player, match, message, this.store.settings().whatsappGroupId);
    }
    if (newestId && this.store.player(player.id)?.enabled && !this.stopped && this.store.settings().monitoringEnabled)
      this.store.updatePlayer(player.id, { lastSeenMatchId: newestId });
  }
  async checkCs2Player(player) {
    const engine = messagesFor('cs2');
    if (player.authCode) {
      let cursor = player.lastSeenMatchId || player.knownCode;
      const codes = await this.cs2.walkSharingCodes(player.steamId, player.authCode, cursor, { maxSteps: 50 });
      for (const code of codes) {
        if (!this.store.player(player.id)?.enabled || this.stopped || !this.store.settings().monitoringEnabled) return;
        if (this.store.hasMatch(player.id, code)) {
          cursor = code;
          this.store.updatePlayer(player.id, { lastSeenMatchId: code, knownCode: code, pendingShareCode: null, pendingSince: null });
          continue;
        }
        const outcome = await this.cs2.matchByShareCode(player, code);
        if (!this.store.player(player.id)?.enabled || this.stopped || !this.store.settings().monitoringEnabled) return;
        if (outcome.state === 'pending') {
          const now = Date.now();
          const current = this.store.player(player.id);
          const firstSeen = current?.pendingShareCode === code && Number.isFinite(current.pendingSince) ? current.pendingSince : now;
          const graceMs = this.cs2.pendingGraceMs ?? 45 * 60_000;
          if (now - firstSeen < graceMs) {
            this.store.updatePlayer(player.id, { lastSeenMatchId: cursor, knownCode: cursor, pendingShareCode: code, pendingSince: firstSeen });
            throw new Error('Nova partida detectada na Steam; aguardando análise da demo (.dem) para enviar o resumo.');
          }
          // Se a demo expirou/falhou nos servidores da Valve, avança para não travar partidas seguintes.
          cursor = code;
          this.store.updatePlayer(player.id, { lastSeenMatchId: code, knownCode: code, pendingShareCode: null, pendingSince: null });
          continue;
        }
        if (outcome.state === 'ignored') {
          cursor = code;
          this.store.updatePlayer(player.id, { lastSeenMatchId: code, knownCode: code, pendingShareCode: null, pendingSince: null });
          continue;
        }
        const { match } = outcome;
        if (Date.parse(match.endedAt) > Date.parse(player.createdAt)) {
          const { message } = engine.formatMessage(match, { config: this.store.messageConfig('cs2') });
          this.store.addMatch(player, match, message, this.store.settings().whatsappGroupId);
        }
        cursor = code;
        this.store.updatePlayer(player.id, { lastSeenMatchId: code, knownCode: code, pendingShareCode: null, pendingSince: null });
      }
      return;
    }
    const matches = await this.cs2.recentMatches(player);
    const newestId = matches[0]?.id || null;
    const unseen = [];
    for (const match of matches) {
      if (match.id === player.lastSeenMatchId) break;
      unseen.push(match);
    }
    for (const match of unseen.reverse()) {
      if (!this.store.player(player.id)?.enabled || this.stopped || !this.store.settings().monitoringEnabled) return;
      if (this.store.hasMatch(player.id, match.id)) continue;
      if (Date.parse(match.endedAt) <= Date.parse(player.createdAt)) continue;
      const { message } = engine.formatMessage(match, { config: this.store.messageConfig('cs2') });
      this.store.addMatch(player, match, message, this.store.settings().whatsappGroupId);
    }
    if (newestId && this.store.player(player.id)?.enabled && !this.stopped && this.store.settings().monitoringEnabled) {
      this.store.updatePlayer(player.id, { lastSeenMatchId: newestId });
    }
  }
  async deliver() {
    if (this.whatsapp.status().state !== 'connected') return;
    for (const entry of this.store.dueDeliveries()) {
      if (this.stopped || !this.store.settings().monitoringEnabled) break;
      if (!this.store.player(entry.playerId)?.enabled) continue;
      try {
        // Reuse the same WhatsApp message ID if delivery is retried after a timeout/restart.
        const messageId = '3EB0' + createHash('sha256').update(entry.id).digest('hex').slice(0, 28).toUpperCase();
        await this.whatsapp.send(entry.groupId, entry.message, { messageId });
        this.store.updateDelivery(entry.id, { status: 'sent', sentAt: new Date().toISOString(), error: null });
      } catch (error) {
        const attempts = entry.attempts + 1;
        this.store.updateDelivery(entry.id, {
          status: 'failed', attempts, error: error.message,
          nextAttemptAt: Date.now() + Math.min(60_000 * 2 ** (attempts - 1), 900_000),
        });
      }
    }
  }
  async close() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.nextCheckAt = null;
    await this.inFlight;
  }
}
