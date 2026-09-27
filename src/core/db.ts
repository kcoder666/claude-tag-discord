import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "../config.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS scopes (
  id TEXT PRIMARY KEY,            -- 'guild:<id>' or 'channel:<id>'
  guild_id TEXT NOT NULL,
  json TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS secrets (
  scope_id TEXT NOT NULL,
  name TEXT NOT NULL,
  env_var TEXT NOT NULL,
  hosts TEXT NOT NULL DEFAULT '[]',
  value_enc TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (scope_id, name)
);
CREATE TABLE IF NOT EXISTS memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  scope TEXT NOT NULL,            -- 'channel' | 'workspace' | 'dm'
  scope_id TEXT NOT NULL,         -- channel id, guild id, or user id
  content TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_scope ON memory(scope, scope_id);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,              -- thread id, 'channel:<id>' or 'dm:<user id>'
  kind TEXT NOT NULL,             -- 'thread' | 'channel' | 'dm'
  guild_id TEXT,
  channel_id TEXT NOT NULL,       -- parent channel (or DM channel)
  thread_id TEXT,
  sdk_session_id TEXT,
  title TEXT,
  model TEXT,
  model_pinned INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  muted INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_key ON sessions(key, status);
CREATE INDEX IF NOT EXISTS sessions_channel ON sessions(channel_id);
CREATE TABLE IF NOT EXISTS routines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT,
  channel_id TEXT NOT NULL,
  thread_id TEXT,
  kind TEXT NOT NULL,             -- 'schedule' | 'pr'
  name TEXT NOT NULL,
  cron TEXT,
  timezone TEXT,
  prompt TEXT NOT NULL,
  repo TEXT,
  pr_number INTEGER,
  owner_kind TEXT NOT NULL DEFAULT 'channel',  -- 'channel' | 'dm'
  created_by TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT '{}',
  last_run_at INTEGER,
  last_status TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT,
  channel_id TEXT,
  user_id TEXT,
  kind TEXT NOT NULL,             -- 'channel' | 'dm' | 'routine'
  work TEXT,                      -- short label of the kind of work
  model TEXT,
  cost_usd REAL NOT NULL,
  metered INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_period ON usage(guild_id, created_at);
CREATE TABLE IF NOT EXISTS alerts_sent (
  scope_id TEXT NOT NULL,
  period TEXT NOT NULL,
  threshold INTEGER NOT NULL,
  PRIMARY KEY (scope_id, period, threshold)
);
CREATE TABLE IF NOT EXISTS channel_state (
  channel_id TEXT PRIMARY KEY,
  guild_id TEXT,
  unread_since_post INTEGER NOT NULL DEFAULT 0,
  last_post_at INTEGER,
  activated INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS bot_messages (
  message_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  session_key TEXT,
  created_at INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS msg_index USING fts5(
  content, author, channel_name,
  channel_id UNINDEXED, guild_id UNINDEXED, message_id UNINDEXED, created_at UNINDEXED, is_public UNINDEXED
);
CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  api_key_enc TEXT,
  dm_model TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT, channel_id TEXT, user_id TEXT, text TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT, channel_id TEXT, kind TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS activity_guild ON activity(guild_id, created_at);
CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY,            -- unguessable, part of the public URL
  session_key TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (session_key, title)
);
`;

let db: DatabaseSync | undefined;

export function getDb(): DatabaseSync {
  if (db) return db;
  const file = config.dbPath;
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

/** For tests: swap in a fresh in-memory database. */
export function useMemoryDb(): DatabaseSync {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  return db;
}

export type Row = Record<string, unknown>;

export function all<T = Row>(sql: string, ...params: unknown[]): T[] {
  return getDb().prepare(sql).all(...(params as never[])) as T[];
}

export function get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
  return getDb().prepare(sql).get(...(params as never[])) as T | undefined;
}

export function run(sql: string, ...params: unknown[]): { lastInsertRowid: number; changes: number } {
  const r = getDb().prepare(sql).run(...(params as never[]));
  return { lastInsertRowid: Number(r.lastInsertRowid), changes: Number(r.changes) };
}

export function logActivity(guildId: string | null, channelId: string | null, kind: string, detail: string): void {
  run(
    "INSERT INTO activity (guild_id, channel_id, kind, detail, created_at) VALUES (?, ?, ?, ?, ?)",
    guildId, channelId, kind, detail.slice(0, 2000), Date.now(),
  );
}
