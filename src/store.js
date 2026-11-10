import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getDefaultMessageConfig, getLegacyPhrasePools, validateMessageConfig } from './message.js';
import { GAME_IDS, messagesFor } from './games.js';
import { getDefaultWeeklyConfig, isLegacyWeeklyConfig, validateWeeklyConfig } from './weekly.js';

// Campos adicionados depois da primeira versão: instalações antigas recebem o padrão ao ler.
const SETTINGS_DEFAULTS = { weeklyEnabled: true, weeklyDay: 0, weeklyHour: 21 };

// Linhas antigas não têm `game` no JSON; a coluna adicionada pela migração é a fonte da verdade.
const parse = row => ({ ...JSON.parse(row.payload), game: row.game });

export class Store {
  constructor(filename, { pollIntervalSeconds = 120 } = {}) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS message_config (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS app_migrations (name TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS players (id TEXT PRIMARY KEY, identity TEXT NOT NULL UNIQUE, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS matches (
        id TEXT PRIMARY KEY, player_id TEXT NOT NULL, riot_match_id TEXT NOT NULL,
        ended_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
        payload TEXT NOT NULL, UNIQUE(player_id, riot_match_id)
      );
      CREATE INDEX IF NOT EXISTS delivery_queue ON matches(status, next_attempt_at);
    `);
    // Migração aditiva multi-jogo: tudo o que já existe continua sendo League of Legends.
    for (const table of ['players', 'matches']) {
      if (!this.db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === 'game')) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN game TEXT NOT NULL DEFAULT 'lol'`);
      }
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS game_message_config (game TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS matches_by_game ON matches(game, ended_at);
      CREATE TABLE IF NOT EXISTS weekly_config (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS weekly_reports (
        id TEXT PRIMARY KEY, game TEXT NOT NULL, week_key TEXT NOT NULL,
        status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
        payload TEXT NOT NULL, UNIQUE(game, week_key)
      );
    `);
    this.db.prepare('INSERT OR IGNORE INTO weekly_config (id,payload) VALUES (1,?)').run(JSON.stringify(getDefaultWeeklyConfig()));
    // Frases padrão antigas e nunca editadas recebem a versão atual; textos do usuário ficam intactos.
    if (isLegacyWeeklyConfig(this.weeklyConfig())) {
      this.db.prepare('UPDATE weekly_config SET payload=? WHERE id=1').run(JSON.stringify(getDefaultWeeklyConfig()));
    }
    // O LoL segue na tabela message_config original; os demais jogos têm modelos próprios.
    for (const game of GAME_IDS.filter(id => id !== 'lol')) {
      this.db.prepare('INSERT OR IGNORE INTO game_message_config (game,payload) VALUES (?,?)')
        .run(game, JSON.stringify(messagesFor(game).defaultConfig()));
    }
    this.db.prepare('INSERT OR IGNORE INTO settings (id,payload) VALUES (1,?)').run(JSON.stringify({
      pollIntervalSeconds, monitoringEnabled: false, whatsappGroupId: '', whatsappGroupName: '',
    }));
    this.db.prepare('INSERT OR IGNORE INTO message_config (id,payload) VALUES (1,?)')
      .run(JSON.stringify(getDefaultMessageConfig()));
    // Add new default fields only when the entire preset text is still pristine.
    // Authored messages, activation choices, names and phrase pools stay user-owned.
    if (!this.db.prepare('SELECT 1 FROM app_migrations WHERE name=?').get('message-presets-mode-v1')) {
      const current = this.messageConfig();
      const presets = new Map(getDefaultMessageConfig().templates.map(template => [template.id, template]));
      let updated = false;
      const templates = current.templates.map(template => {
        const preset = presets.get(template.id);
        if (!preset || !preset.text.split('\n').includes('Modo: {{modo}}')) return template;
        const previousText = preset.text.split('\n').filter(line => line !== 'Modo: {{modo}}').join('\n');
        if (template.text !== previousText) return template;
        updated = true;
        return { ...template, text: preset.text };
      });
      if (updated) this.updateMessageConfig({ ...current, templates });
      this.db.prepare('INSERT INTO app_migrations(name) VALUES (?)').run('message-presets-mode-v1');
    }
    if (!this.db.prepare('SELECT 1 FROM app_migrations WHERE name=?').get('message-kda-bands-v1')) {
      const current = this.messageConfig();
      const legacy = getLegacyPhrasePools();
      const defaults = getDefaultMessageConfig();
      const phrases = { ...current.phrases };
      let updated = false;
      for (const category of Object.keys(defaults.phrases)) {
        if (JSON.stringify(phrases[category]) === JSON.stringify(legacy[category])) {
          // A longer default phrase must not invalidate an authored template near the render limit.
          try { validateMessageConfig({ ...current, phrases: { ...phrases, [category]: defaults.phrases[category] } }); }
          catch (error) {
            if (error.name === 'MessageConfigError') continue;
            throw error;
          }
          phrases[category] = defaults.phrases[category];
          updated = true;
        }
      }
      if (updated) this.updateMessageConfig({ ...current, phrases });
      this.db.prepare('INSERT INTO app_migrations(name) VALUES (?)').run('message-kda-bands-v1');
    }
    // Frases mais ácidas (10/11/2026): só troca categorias idênticas a um padrão antigo, em cada jogo.
    if (!this.db.prepare('SELECT 1 FROM app_migrations WHERE name=?').get('message-acid-phrases-v1')) {
      for (const game of GAME_IDS) {
        const engine = messagesFor(game);
        const current = this.messageConfig(game);
        const defaults = engine.defaultConfig();
        const previous = engine.previousPhrasePools();
        const phrases = { ...current.phrases };
        let updated = false;
        for (const category of Object.keys(defaults.phrases)) {
          const pristine = previous.some(pools => JSON.stringify(pools[category]) === JSON.stringify(phrases[category]));
          if (!pristine) continue;
          const candidate = { ...phrases, [category]: defaults.phrases[category] };
          try { engine.validateConfig({ ...current, phrases: candidate }); }
          catch (error) {
            if (error.name === 'MessageConfigError') continue;
            throw error;
          }
          phrases[category] = defaults.phrases[category];
          updated = true;
        }
        if (updated) this.updateMessageConfig({ ...current, phrases }, game);
      }
      this.db.prepare('INSERT INTO app_migrations(name) VALUES (?)').run('message-acid-phrases-v1');
    }
  }

  messageConfig(game = 'lol') {
    if (game !== 'lol') return JSON.parse(this.db.prepare('SELECT payload FROM game_message_config WHERE game=?').get(game).payload);
    return JSON.parse(this.db.prepare('SELECT payload FROM message_config WHERE id=1').get().payload);
  }
  updateMessageConfig(config, game = 'lol') {
    const normalized = messagesFor(game).validateConfig(config);
    if (game !== 'lol') this.db.prepare('UPDATE game_message_config SET payload=? WHERE game=?').run(JSON.stringify(normalized), game);
    else this.db.prepare('UPDATE message_config SET payload=? WHERE id=1').run(JSON.stringify(normalized));
    return normalized;
  }
  settings() {
    return { ...SETTINGS_DEFAULTS, ...JSON.parse(this.db.prepare('SELECT payload FROM settings WHERE id=1').get().payload) };
  }
  updateSettings(patch) {
    const settings = { ...this.settings(), ...patch };
    this.db.prepare('UPDATE settings SET payload=? WHERE id=1').run(JSON.stringify(settings));
    return settings;
  }
  players(game = null) {
    const rows = game
      ? this.db.prepare('SELECT game,payload FROM players WHERE game=? ORDER BY rowid DESC').all(game)
      : this.db.prepare('SELECT game,payload FROM players ORDER BY rowid DESC').all();
    return rows.map(parse);
  }
  player(id) {
    const row = this.db.prepare('SELECT game,payload FROM players WHERE id=?').get(id);
    return row ? parse(row) : null;
  }
  addPlayer(account, region, lastSeenMatchId = null, game = account?.game || 'lol') {
    const player = {
      id: randomUUID(), ...account, game, region, enabled: true,
      createdAt: new Date().toISOString(), lastSeenMatchId,
      lastCheckedAt: null, lastError: null,
    };
    const identity = game === 'lol' ? `${region}:${account.puuid}` : `${game}:${account.steamId}`;
    this.db.prepare('INSERT INTO players (id,game,identity,payload) VALUES (?,?,?,?)')
      .run(player.id, game, identity, JSON.stringify(player));
    return player;
  }
  updatePlayer(id, patch) {
    const previous = this.player(id);
    if (!previous) return null;
    const player = { ...previous, ...patch, game: previous.game };
    this.db.prepare('UPDATE players SET payload=? WHERE id=?').run(JSON.stringify(player), id);
    return player;
  }
  removePlayer(id) {
    this.db.prepare('DELETE FROM players WHERE id=?').run(id);
    // Preserve the history but cancel deliveries belonging to a removed player.
    for (const match of this.db.prepare("SELECT game,payload FROM matches WHERE player_id=? AND status!='sent'").all(id)) {
      const entry = parse(match);
      this.updateDelivery(entry.id, { status: 'failed', attempts: 5, error: 'Jogador removido. Envio cancelado.' });
    }
  }
  hasMatch(playerId, riotMatchId) {
    return Boolean(this.db.prepare('SELECT 1 FROM matches WHERE player_id=? AND riot_match_id=?').get(playerId, riotMatchId));
  }
  addMatch(player, match, message, groupId) {
    const game = player.game || match.game || 'lol';
    const entry = {
      ...match, game, id: randomUUID(), riotMatchId: match.id, playerId: player.id,
      message, groupId, status: 'pending', attempts: 0, nextAttemptAt: 0,
      error: null, sentAt: null, createdAt: new Date().toISOString(),
    };
    this.db.prepare(`INSERT OR IGNORE INTO matches
      (id,game,player_id,riot_match_id,ended_at,status,payload) VALUES (?,?,?,?,?,'pending',?)`)
      .run(entry.id, game, player.id, match.id, match.endedAt, JSON.stringify(entry));
    return entry;
  }
  matches(limit = 100, game = null) {
    const rows = game
      ? this.db.prepare('SELECT game,payload FROM matches WHERE game=? ORDER BY ended_at DESC, rowid DESC LIMIT ?').all(game, limit)
      : this.db.prepare('SELECT game,payload FROM matches ORDER BY ended_at DESC, rowid DESC LIMIT ?').all(limit);
    return rows.map(parse);
  }
  match(id) {
    const row = this.db.prepare('SELECT game,payload FROM matches WHERE id=?').get(id);
    return row ? parse(row) : null;
  }
  dueDeliveries(now = Date.now()) {
    return this.db.prepare(`SELECT game,payload FROM matches WHERE status IN ('pending','failed')
      AND attempts<5 AND next_attempt_at<=? ORDER BY ended_at ASC LIMIT 20`)
      .all(now).map(parse);
  }
  updateDelivery(id, patch) {
    const previous = this.match(id);
    if (!previous) return null;
    const entry = { ...previous, ...patch, game: previous.game };
    this.db.prepare('UPDATE matches SET status=?,attempts=?,next_attempt_at=?,payload=? WHERE id=?')
      .run(entry.status, entry.attempts, entry.nextAttemptAt, JSON.stringify(entry), id);
    return entry;
  }
  stats(game = null) {
    const rows = game
      ? this.db.prepare('SELECT status,COUNT(*) AS count FROM matches WHERE game=? GROUP BY status').all(game)
      : this.db.prepare('SELECT status,COUNT(*) AS count FROM matches GROUP BY status').all();
    const counts = Object.fromEntries(rows.map(row => [row.status, Number(row.count)]));
    return {
      players: this.players(game).length,
      matches: Object.values(counts).reduce((a, b) => a + b, 0),
      sent: counts.sent || 0,
      pending: (counts.pending || 0) + (counts.failed || 0),
    };
  }
  /** Partidas detectadas (createdAt) no intervalo (start, end], para o resumo semanal. */
  matchesDetectedBetween(game, start, end) {
    return this.db.prepare(`SELECT game,payload FROM matches WHERE game=?
      AND json_extract(payload,'$.createdAt') > ? AND json_extract(payload,'$.createdAt') <= ?`)
      .all(game, new Date(start).toISOString(), new Date(end).toISOString()).map(parse);
  }
  weeklyConfig() { return JSON.parse(this.db.prepare('SELECT payload FROM weekly_config WHERE id=1').get().payload); }
  updateWeeklyConfig(config) {
    const normalized = validateWeeklyConfig(config);
    this.db.prepare('UPDATE weekly_config SET payload=? WHERE id=1').run(JSON.stringify(normalized));
    return normalized;
  }
  hasWeeklyReport(game, weekKey) {
    return Boolean(this.db.prepare('SELECT 1 FROM weekly_reports WHERE game=? AND week_key=?').get(game, weekKey));
  }
  /** Registra o resumo da semana uma única vez por jogo; `message` nulo marca semana sem partidas. */
  addWeeklyReport({ game, weekKey, period, start, end, message, groupId, players = [] }) {
    const entry = {
      id: randomUUID(), game, weekKey, period, start: new Date(start).toISOString(), end: new Date(end).toISOString(),
      message, groupId, players, status: message ? 'pending' : 'skipped', attempts: 0, nextAttemptAt: 0,
      error: null, sentAt: null, createdAt: new Date().toISOString(),
    };
    const result = this.db.prepare(`INSERT OR IGNORE INTO weekly_reports (id,game,week_key,status,payload)
      VALUES (?,?,?,?,?)`).run(entry.id, game, weekKey, entry.status, JSON.stringify(entry));
    return result.changes ? entry : null;
  }
  weeklyReports(limit = 10) {
    return this.db.prepare('SELECT payload FROM weekly_reports ORDER BY week_key DESC, game ASC LIMIT ?')
      .all(limit).map(row => JSON.parse(row.payload));
  }
  weeklyReport(id) {
    const row = this.db.prepare('SELECT payload FROM weekly_reports WHERE id=?').get(id);
    return row ? JSON.parse(row.payload) : null;
  }
  dueWeeklyReports(now = Date.now()) {
    return this.db.prepare(`SELECT payload FROM weekly_reports WHERE status IN ('pending','failed')
      AND attempts<5 AND next_attempt_at<=? ORDER BY week_key ASC, game ASC LIMIT 10`)
      .all(now).map(row => JSON.parse(row.payload));
  }
  updateWeeklyReport(id, patch) {
    const previous = this.weeklyReport(id);
    if (!previous) return null;
    const entry = { ...previous, ...patch };
    this.db.prepare('UPDATE weekly_reports SET status=?,attempts=?,next_attempt_at=?,payload=? WHERE id=?')
      .run(entry.status, entry.attempts, entry.nextAttemptAt, JSON.stringify(entry), id);
    return entry;
  }
  close() { this.db.close(); }
}
