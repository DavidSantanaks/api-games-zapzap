import { createHash } from 'node:crypto';
import { formatMessage } from './message.js';
import { GAME_IDS, messagesFor } from './games.js';
import { dueWeeklyWindow, renderWeeklyReport, summarizeWeek } from './weekly.js';

const RIOT_MISSING = 'Configure RIOT_API_KEY no arquivo .env. No Docker, aplique com: docker compose up -d --force-recreate. Na execução local, reinicie o app.';
const R6_MISSING = 'Configure STATS_CC_API_KEY no arquivo .env. No Docker, aplique com: docker compose up -d --force-recreate. Na execução local, reinicie o app.';
const CS2_MISSING = 'Configure STEAM_API_KEY (e opcionalmente LEETIFY_API_KEY) no arquivo .env. No Docker, aplique com: docker compose up -d --force-recreate. Na execução local, reinicie o app.';

export class Monitor {
  constructor({ store, riot, cs2 = null, r6 = null, whatsapp, logger = console, now = () => Date.now() }) {
    Object.assign(this, { store, riot, cs2, r6, whatsapp, logger, now });
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
      if (!enabledPlayers.length && !this.riot?.configured && !this.cs2?.configured && !this.r6?.configured) {
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
          } else if (game === 'r6') {
            if (!this.r6?.configured) throw new Error(R6_MISSING);
            await this.checkR6Player(player);
          } else {
            if (!this.riot?.configured) throw new Error(RIOT_MISSING);
            await this.checkPlayer(player);
          }
          if (this.store.player(player.id)) this.store.updatePlayer(player.id, { lastCheckedAt: new Date().toISOString(), lastError: null });
        } catch (error) {
          // Perfil oculto pelo dono (termos da stats.cc): pausa o player, o que também segura os envios pendentes.
          const hidden = error.kind === 'hidden_profile' ? { enabled: false } : {};
          if (this.store.player(player.id)) this.store.updatePlayer(player.id, { lastCheckedAt: new Date().toISOString(), lastError: error.message, ...hidden });
          this.lastError = error.message;
          if (error.retryAfterMs > 0) rateLimited.add(game);
        }
      }
      try { this.generateWeeklyReports(); }
      catch (error) { this.logger.error({ err: error.message }, 'Falha ao gerar o resumo semanal'); }
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
  /** Rainbow Six Siege: só partidas novas depois do cursor (`after`), filtradas pelas playlists acompanhadas. */
  async checkR6Player(player) {
    const engine = messagesFor('r6');
    const entries = await this.r6.newMatches(player);
    const active = () => this.store.player(player.id)?.enabled && !this.stopped && this.store.settings().monitoringEnabled;
    for (const { id, match, error } of entries) {
      if (!active()) return;
      if (error) this.logger.error({ err: error, matchId: id }, 'Partida do R6 ignorada');
      if (match && !this.store.hasMatch(player.id, id) && Date.parse(match.endedAt) > Date.parse(player.createdAt)) {
        const { message } = engine.formatMessage(match, { config: this.store.messageConfig('r6') });
        this.store.addMatch(player, match, message, this.store.settings().whatsappGroupId);
      }
      // O cursor avança partida a partida: uma falha no meio não reenvia nem perde as anteriores.
      this.store.updatePlayer(player.id, { lastSeenMatchId: id });
    }
  }
  /**
   * Gera, uma única vez por jogo e semana, o resumo das partidas detectadas na semana encerrada.
   * Só roda até 24 horas depois do horário agendado; semanas sem partidas ficam registradas como puladas.
   */
  generateWeeklyReports() {
    const settings = this.store.settings();
    if (!settings.weeklyEnabled || !settings.whatsappGroupId) return [];
    const week = dueWeeklyWindow(this.now(), { weeklyDay: settings.weeklyDay, weeklyHour: settings.weeklyHour });
    if (!week) return [];
    const created = [];
    for (const game of GAME_IDS) {
      if (this.store.hasWeeklyReport(game, week.key)) continue;
      const players = this.store.players(game).filter(player => player.enabled);
      const summaries = summarizeWeek(players, this.store.matchesDetectedBetween(game, week.start, week.end));
      const report = renderWeeklyReport({ game, summaries, period: week.period, seed: week.key, config: this.store.weeklyConfig() });
      const entry = this.store.addWeeklyReport({
        game, weekKey: week.key, period: week.period, start: week.start, end: week.end,
        message: report?.message || null, groupId: settings.whatsappGroupId, players: report?.players || [],
      });
      if (entry) created.push(entry);
    }
    return created;
  }
  messageId(seed) {
    return '3EB0' + createHash('sha256').update(seed).digest('hex').slice(0, 28).toUpperCase();
  }
  async deliver() {
    if (this.whatsapp.status().state !== 'connected') return;
    await this.deliverMatches();
    await this.deliverWeeklyReports();
  }
  async deliverWeeklyReports() {
    for (const report of this.store.dueWeeklyReports(this.now())) {
      if (this.stopped || !this.store.settings().monitoringEnabled) break;
      try {
        await this.whatsapp.send(report.groupId, report.message, { messageId: this.messageId(`weekly:${report.id}`) });
        this.store.updateWeeklyReport(report.id, { status: 'sent', sentAt: new Date(this.now()).toISOString(), error: null });
      } catch (error) {
        const attempts = report.attempts + 1;
        this.store.updateWeeklyReport(report.id, {
          status: 'failed', attempts, error: error.message,
          nextAttemptAt: this.now() + Math.min(60_000 * 2 ** (attempts - 1), 900_000),
        });
      }
    }
  }
  async deliverMatches() {
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
