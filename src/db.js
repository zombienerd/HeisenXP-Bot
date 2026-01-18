const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(path.join(__dirname, "..", "xpbot.sqlite"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  guild_id TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  xp       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS activity_log (
  guild_id TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  kind     TEXT NOT NULL, -- message|reaction|voice_minute
  amount   INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_recent
ON activity_log (guild_id, user_id, kind, created_at);

-- Per-guild settings (one row per guild)
CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id TEXT PRIMARY KEY,
  msg_xp INTEGER NOT NULL DEFAULT 5,
  reaction_xp INTEGER NOT NULL DEFAULT 2,
  voice_xp_per_min INTEGER NOT NULL DEFAULT 1,
  msg_cooldown_sec INTEGER NOT NULL DEFAULT 20,
  reaction_cooldown_sec INTEGER NOT NULL DEFAULT 10,

  decay_enabled INTEGER NOT NULL DEFAULT 1,
  decay_window_days INTEGER NOT NULL DEFAULT 7,
  decay_min_messages INTEGER NOT NULL DEFAULT 20,
  decay_percent REAL NOT NULL DEFAULT 0.10,

  level_xp_factor INTEGER NOT NULL DEFAULT 100,
  updated_at INTEGER NOT NULL
);

-- Level -> role mapping, plus drop grace days
CREATE TABLE IF NOT EXISTS level_roles (
  guild_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  level_required INTEGER NOT NULL,
  drop_grace_days INTEGER NOT NULL DEFAULT 3,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, role_id)
);

-- Tracks when user first fell below a role's required level (to enforce "more than X days")
CREATE TABLE IF NOT EXISTS role_drop_state (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  below_since INTEGER, -- ms epoch, NULL when not below
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id, role_id)
);

-- Allowed command channels per guild (if empty => commands allowed everywhere)
CREATE TABLE IF NOT EXISTS allowed_command_channels (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, channel_id)
);
`);

function now() {
  return Date.now();
}

function ensureGuildSettings(guildId) {
  db.prepare(
    `INSERT INTO guild_settings (guild_id, updated_at)
     VALUES (?, ?)
     ON CONFLICT(guild_id) DO UPDATE SET updated_at=excluded.updated_at`
  ).run(guildId, now());
}

function getGuildSettings(guildId) {
  ensureGuildSettings(guildId);
  // Guaranteed to exist after ensureGuildSettings
  return db.prepare(`SELECT * FROM guild_settings WHERE guild_id=?`).get(guildId);
}

function updateGuildSettings(guildId, patch) {
  ensureGuildSettings(guildId);

  const allowed = new Set([
    "msg_xp",
    "reaction_xp",
    "voice_xp_per_min",
    "msg_cooldown_sec",
    "reaction_cooldown_sec",
    "decay_enabled",
    "decay_window_days",
    "decay_min_messages",
    "decay_percent",
    "level_xp_factor",
  ]);

  const keys = Object.keys(patch).filter((k) => allowed.has(k));
  if (!keys.length) return getGuildSettings(guildId);

  const sets = keys.map((k) => `${k}=@${k}`).join(", ");
  db.prepare(
    `UPDATE guild_settings
     SET ${sets}, updated_at=@updated_at
     WHERE guild_id=@guild_id`
  ).run({ guild_id: guildId, updated_at: now(), ...patch });

  return getGuildSettings(guildId);
}

function ensureUser(guildId, userId) {
  const t = now();
  db.prepare(
    `INSERT INTO users (guild_id, user_id, xp, created_at, updated_at)
     VALUES (?, ?, 0, ?, ?)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET updated_at=excluded.updated_at`
  ).run(guildId, userId, t, t);
}

/**
 * Atomically add XP.
 * This avoids lost updates under concurrent events because XP increments happen in SQL.
 */
function addXp(guildId, userId, delta) {
  ensureUser(guildId, userId);
  const t = now();

  // Atomic update; clamp at 0
  db.prepare(
    `UPDATE users
     SET xp = MAX(0, xp + ?),
         updated_at = ?
     WHERE guild_id = ? AND user_id = ?`
  ).run(delta, t, guildId, userId);

  const row = db.prepare(`SELECT xp FROM users WHERE guild_id=? AND user_id=?`).get(guildId, userId);
  return row?.xp ?? 0;
}

function setXp(guildId, userId, xp) {
  ensureUser(guildId, userId);
  db.prepare(
    `UPDATE users
     SET xp=?, updated_at=?
     WHERE guild_id=? AND user_id=?`
  ).run(Math.max(0, Math.floor(xp)), now(), guildId, userId);
}

function getXp(guildId, userId) {
  const row = db.prepare(`SELECT xp FROM users WHERE guild_id=? AND user_id=?`).get(guildId, userId);
  return row?.xp ?? 0;
}

function topUsers(guildId, limit = 10) {
  return db.prepare(
    `SELECT user_id, xp
     FROM users
     WHERE guild_id=?
     ORDER BY xp DESC
     LIMIT ?`
  ).all(guildId, limit);
}

function logActivity(guildId, userId, kind, amount = 1) {
  db.prepare(
    `INSERT INTO activity_log (guild_id, user_id, kind, amount, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(guildId, userId, kind, amount, now());
}

function countMessagesInWindow(guildId, userId, windowDays) {
  const since = now() - windowDays * 24 * 60 * 60 * 1000;
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS c
       FROM activity_log
       WHERE guild_id=? AND user_id=? AND kind='message' AND created_at >= ?`
    )
    .get(guildId, userId, since);
  return row?.c ?? 0;
}

function allUsersInGuild(guildId) {
  return db.prepare(`SELECT user_id, xp FROM users WHERE guild_id=?`).all(guildId);
}

// Level roles
function upsertLevelRole(guildId, roleId, levelRequired, dropGraceDays) {
  const t = now();
  db.prepare(
    `INSERT INTO level_roles (guild_id, role_id, level_required, drop_grace_days, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(guild_id, role_id) DO UPDATE SET
       level_required=excluded.level_required,
       drop_grace_days=excluded.drop_grace_days,
       updated_at=excluded.updated_at`
  ).run(guildId, roleId, levelRequired, dropGraceDays, t, t);
}

function deleteLevelRole(guildId, roleId) {
  db.prepare(`DELETE FROM level_roles WHERE guild_id=? AND role_id=?`).run(guildId, roleId);
  db.prepare(`DELETE FROM role_drop_state WHERE guild_id=? AND role_id=?`).run(guildId, roleId);
}

function listLevelRoles(guildId) {
  return db
    .prepare(
      `SELECT role_id, level_required, drop_grace_days
       FROM level_roles
       WHERE guild_id=?
       ORDER BY level_required ASC`
    )
    .all(guildId);
}

// Role drop state
function getRoleDropState(guildId, userId, roleId) {
  return db
    .prepare(
      `SELECT below_since
       FROM role_drop_state
       WHERE guild_id=? AND user_id=? AND role_id=?`
    )
    .get(guildId, userId, roleId);
}

function setRoleBelowSince(guildId, userId, roleId, belowSinceOrNull) {
  const t = now();
  db.prepare(
    `INSERT INTO role_drop_state (guild_id, user_id, role_id, below_since, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(guild_id, user_id, role_id) DO UPDATE SET
       below_since=excluded.below_since,
       updated_at=excluded.updated_at`
  ).run(guildId, userId, roleId, belowSinceOrNull, t);
}

// Allowed command channels
function addAllowedCommandChannel(guildId, channelId) {
  db.prepare(
    `INSERT OR IGNORE INTO allowed_command_channels (guild_id, channel_id, created_at)
     VALUES (?, ?, ?)`
  ).run(guildId, channelId, now());
}

function removeAllowedCommandChannel(guildId, channelId) {
  db.prepare(`DELETE FROM allowed_command_channels WHERE guild_id=? AND channel_id=?`).run(guildId, channelId);
}

function listAllowedCommandChannels(guildId) {
  return db
    .prepare(
      `SELECT channel_id
       FROM allowed_command_channels
       WHERE guild_id=?
       ORDER BY created_at ASC`
    )
    .all(guildId);
}

module.exports = {
  db,
  now,
  // guild settings
  getGuildSettings,
  updateGuildSettings,
  // users/xp
  addXp,
  setXp,
  getXp,
  topUsers,
  allUsersInGuild,
  // activity
  logActivity,
  countMessagesInWindow,
  // level roles
  upsertLevelRole,
  deleteLevelRole,
  listLevelRoles,
  getRoleDropState,
  setRoleBelowSince,
  // allowed channels
  addAllowedCommandChannel,
  removeAllowedCommandChannel,
  listAllowedCommandChannels,
};
