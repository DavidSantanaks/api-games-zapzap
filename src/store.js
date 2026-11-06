import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getDefaultMessageConfig, validateMessageConfig } from './message.js';

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
  }

  messageConfig() {
    return JSON.parse(this.db.prepare('SELECT payload FROM message_config WHERE id=1').get().payload);
  }
  updateMessageConfig(config) {
    const normalized = validateMessageConfig(config);
    this.db.prepare('UPDATE message_config SET payload=? WHERE id=1').run(JSON.stringify(normalized));
    return normalized;
  }
  settings() { return JSON.parse(this.db.prepare('SELECT payload FROM settings WHERE id=1').get().payload); }
  updateSettings(patch) {
    const settings = { ...this.settings(), ...patch };
    this.db.prepare('UPDATE settings SET payload=? WHERE id=1').run(JSON.stringify(settings));
    return settings;
  }
  players() { return this.db.prepare('SELECT payload FROM players ORDER BY rowid DESC').all().map(row => JSON.parse(row.payload)); }
  player(id) {
    const row = this.db.prepare('SELECT payload FROM players WHERE id=?').get(id);
    return row ? JSON.parse(row.payload) : null;
  }
  addPlayer(account, region, lastSeenMatchId = null) {
    const player = {
      id: randomUUID(), ...account, region, enabled: true,
      createdAt: new Date().toISOString(), lastSeenMatchId,
      lastCheckedAt: null, lastError: null,
    };
    this.db.prepare('INSERT INTO players (id,identity,payload) VALUES (?,?,?)')
      .run(player.id, `${region}:${account.puuid}`, JSON.stringify(player));
    return player;
  }
  updatePlayer(id, patch) {
    const previous = this.player(id);
    if (!previous) return null;
    const player = { ...previous, ...patch };
    this.db.prepare('UPDATE players SET payload=? WHERE id=?').run(JSON.stringify(player), id);
    return player;
  }
  removePlayer(id) {
    this.db.prepare('DELETE FROM players WHERE id=?').run(id);
    // Preserve the history but cancel deliveries belonging to a removed player.
    for (const match of this.db.prepare("SELECT payload FROM matches WHERE player_id=? AND status!='sent'").all(id)) {
      const entry = JSON.parse(match.payload);
      this.updateDelivery(entry.id, { status: 'failed', attempts: 5, error: 'Jogador removido. Envio cancelado.' });
    }
  }
  hasMatch(playerId, riotMatchId) {
    return Boolean(this.db.prepare('SELECT 1 FROM matches WHERE player_id=? AND riot_match_id=?').get(playerId, riotMatchId));
  }
  addMatch(player, match, message, groupId) {
    const entry = {
      ...match, id: randomUUID(), riotMatchId: match.id, playerId: player.id,
      message, groupId, status: 'pending', attempts: 0, nextAttemptAt: 0,
      error: null, sentAt: null, createdAt: new Date().toISOString(),
    };
    this.db.prepare(`INSERT OR IGNORE INTO matches
      (id,player_id,riot_match_id,ended_at,status,payload) VALUES (?,?,?,?,'pending',?)`)
      .run(entry.id, player.id, match.id, match.endedAt, JSON.stringify(entry));
    return entry;
  }
  matches(limit = 100) {
    return this.db.prepare('SELECT payload FROM matches ORDER BY ended_at DESC, rowid DESC LIMIT ?')
      .all(limit).map(row => JSON.parse(row.payload));
  }
  match(id) {
    const row = this.db.prepare('SELECT payload FROM matches WHERE id=?').get(id);
    return row ? JSON.parse(row.payload) : null;
  }
  dueDeliveries(now = Date.now()) {
    return this.db.prepare(`SELECT payload FROM matches WHERE status IN ('pending','failed')
      AND attempts<5 AND next_attempt_at<=? ORDER BY ended_at ASC LIMIT 20`)
      .all(now).map(row => JSON.parse(row.payload));
  }
  updateDelivery(id, patch) {
    const previous = this.match(id);
    if (!previous) return null;
    const entry = { ...previous, ...patch };
    this.db.prepare('UPDATE matches SET status=?,attempts=?,next_attempt_at=?,payload=? WHERE id=?')
      .run(entry.status, entry.attempts, entry.nextAttemptAt, JSON.stringify(entry), id);
    return entry;
  }
  stats() {
    const rows = this.db.prepare('SELECT status,COUNT(*) AS count FROM matches GROUP BY status').all();
    const counts = Object.fromEntries(rows.map(row => [row.status, Number(row.count)]));
    return { players: this.players().length, matches: Object.values(counts).reduce((a, b) => a + b, 0),
      sent: counts.sent || 0, pending: (counts.pending || 0) + (counts.failed || 0) };
  }
  close() { this.db.close(); }
}
