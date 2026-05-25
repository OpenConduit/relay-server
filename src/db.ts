import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

const DB_PATH = process.env.DB_PATH ?? path.join(process.cwd(), 'data', 'relay.db');

/** 30-day TTL for shared conversation snapshots. */
const SHARE_TTL_SECONDS = 30 * 24 * 60 * 60;

let db: DatabaseSync | undefined;

function getDb(): DatabaseSync {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

export function initDb(): void {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS shares (
      id         TEXT    PRIMARY KEY,
      data       TEXT    NOT NULL,
      machine_id TEXT,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_shares_expires ON shares(expires_at);
  `);
}

export function createShare(
  id: string,
  data: unknown,
  machineId?: string | null,
): void {
  const expiresAt = Math.floor(Date.now() / 1000) + SHARE_TTL_SECONDS;
  getDb()
    .prepare('INSERT INTO shares (id, data, machine_id, expires_at) VALUES (?, ?, ?, ?)')
    .run(id, JSON.stringify(data), machineId ?? null, expiresAt);
}

export function getShare(id: string): unknown | null {
  const row = getDb()
    .prepare('SELECT data, expires_at FROM shares WHERE id = ?')
    .get(id) as { data: string; expires_at: number } | undefined;

  if (!row) return null;

  if (row.expires_at < Math.floor(Date.now() / 1000)) {
    getDb().prepare('DELETE FROM shares WHERE id = ?').run(id);
    return null;
  }

  return JSON.parse(row.data) as unknown;
}

export function deleteShare(id: string, machineId: string): 'ok' | 'not_found' | 'forbidden' {
  const row = getDb()
    .prepare('SELECT machine_id FROM shares WHERE id = ?')
    .get(id) as { machine_id: string | null } | undefined;

  if (!row) return 'not_found';
  if (row.machine_id && row.machine_id !== machineId) return 'forbidden';

  getDb().prepare('DELETE FROM shares WHERE id = ?').run(id);
  return 'ok';
}

export function cleanupExpiredShares(): void {
  const now = Math.floor(Date.now() / 1000);
  const result = getDb()
    .prepare('DELETE FROM shares WHERE expires_at < ?')
    .run(now);
  if (Number(result.changes) > 0) {
    console.log(`[cleanup] Removed ${result.changes} expired share(s)`);
  }
}
