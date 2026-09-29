// The auth database (SQLite, in the config directory): sessions, the OIDC
// logins in flight, the people who have signed in, and the audit log.

import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./config";

export function openDb(file = process.env.QUERIER_DB ?? join(configDir, "querier.db")): Database {
  if (file !== ":memory:") mkdirSync(join(file, ".."), { recursive: true });
  const db = new Database(file, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  // sessions, grants, people's attributes, the audit log: the owner's alone, as auth.json is
  if (file !== ":memory:") for (const f of [file, `${file}-wal`, `${file}-shm`]) if (existsSync(f)) chmodSync(f, 0o600);
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id_hash TEXT PRIMARY KEY,
      principal TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      refresh TEXT,
      created INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      refreshed INTEGER NOT NULL,
      expires INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_principal ON sessions(principal_id);
    CREATE TABLE IF NOT EXISTS oidc_flows (
      state TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      verifier TEXT NOT NULL,
      nonce TEXT NOT NULL,
      next TEXT NOT NULL,
      binding TEXT NOT NULL DEFAULT '',
      created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      username TEXT NOT NULL,
      principal TEXT NOT NULL,
      last_login INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS grants (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      target TEXT NOT NULL,
      subject TEXT NOT NULL,
      role TEXT NOT NULL,
      created_by TEXT,
      created INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS grants_target ON grants(scope, target);
    CREATE TABLE IF NOT EXISTS notebook_attributes (
      id TEXT PRIMARY KEY,
      attrs TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS environments (
      target TEXT NOT NULL,
      kind TEXT NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (target, kind)
    );
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      actor TEXT,
      action TEXT NOT NULL,
      resource TEXT,
      decision TEXT,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS audit_ts ON audit(ts);
  `);
  // columns added since
  try {
    db.exec("ALTER TABLE oidc_flows ADD COLUMN binding TEXT NOT NULL DEFAULT ''");
  } catch {}
  return db;
}
