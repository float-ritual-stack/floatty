import "server-only";

import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type {
  Session,
  SessionBlockRow,
  SessionBlockSource,
  SessionListItem,
  SessionRow,
  CreateSessionInput,
  UpdateSessionInput,
} from "./types";

/**
 * SQLite-backed session store for outline-explorer chat persistence.
 *
 * Lives at `~/.outline-explorer/sessions.db` by default (matching floatty's
 * `~/.floatty/` convention). Override via `OUTLINE_EXPLORER_DB` env var —
 * useful for tests (in-memory `:memory:`) and CI (temp file).
 *
 * better-sqlite3 is synchronous + transactional; fits Next route handlers
 * fine. Schema bootstrap runs on first `getDb()` call and is idempotent —
 * forward-only migrations live in `MIGRATIONS` below.
 *
 * The handle is module-scoped + lazy. Tests can call `resetDb()` to drop
 * the cached handle between cases.
 */

function defaultDbPath(): string {
  return `${homedir()}/.outline-explorer/sessions.db`;
}

function resolveDbPath(): string {
  return process.env.OUTLINE_EXPLORER_DB || defaultDbPath();
}

let dbCache: Database.Database | null = null;
let dbCachePath: string | null = null;

function getDb(): Database.Database {
  const path = resolveDbPath();
  if (dbCache && dbCachePath === path) return dbCache;
  // Path changed since last call (e.g., env-var swap mid-test, or a
  // test that didn't call resetDb()). Close the old handle before
  // opening the new one so we don't leak sqlite connections.
  if (dbCache && dbCachePath !== path) {
    dbCache.close();
    dbCache = null;
    dbCachePath = null;
  }

  // Ensure parent dir exists for file-backed databases (skip `:memory:`).
  if (path !== ":memory:" && !existsSync(dirname(path))) {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);

  dbCache = db;
  dbCachePath = path;
  return db;
}

/** Test-only: drop the cached handle so the next call rebuilds it. */
export function resetDb(): void {
  if (dbCache) dbCache.close();
  dbCache = null;
  dbCachePath = null;
}

// Forward-only migrations. Each migration must be idempotent on its own
// (we run them all every cold start) or guarded by version below.
const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS sessions (
        id              TEXT PRIMARY KEY,
        title           TEXT NOT NULL,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        messages_json   TEXT NOT NULL,
        origin_page_id  TEXT,
        origin_selected TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);

      CREATE TABLE IF NOT EXISTS session_blocks (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        block_id   TEXT NOT NULL,
        source     TEXT NOT NULL CHECK (source IN ('context', 'tool-output', 'wikilink')),
        touched_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, block_id, source)
      );
      CREATE INDEX IF NOT EXISTS idx_session_blocks_block ON session_blocks(block_id, touched_at DESC);

      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY
      );
    `,
  },
];

function runMigrations(db: Database.Database): void {
  // Create schema_version eagerly so we can read it.
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);`);
  const current = (db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number | null }).v ?? 0;
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.exec(migration.sql);
    db.prepare("INSERT OR REPLACE INTO schema_version (version) VALUES (?)").run(migration.version);
  }
}

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    messages: JSON.parse(row.messagesJson),
    originPageId: row.originPageId,
    originSelected: row.originSelected ? JSON.parse(row.originSelected) : [],
  };
}

function readRow(row: Record<string, unknown>): SessionRow {
  return {
    id: row.id as string,
    title: row.title as string,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    messagesJson: row.messages_json as string,
    originPageId: (row.origin_page_id as string | null) ?? null,
    originSelected: (row.origin_selected as string | null) ?? null,
  };
}

export function createSession(input: CreateSessionInput = {}): Session {
  const db = getDb();
  const now = Date.now();
  const id = randomUUID();
  const title = (input.title?.trim() || "New conversation").slice(0, 200);
  const originSelected = input.originSelectedIds?.length
    ? JSON.stringify(input.originSelectedIds)
    : null;

  db.prepare(
    `INSERT INTO sessions (id, title, created_at, updated_at, messages_json, origin_page_id, origin_selected)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, title, now, now, "[]", input.originPageId ?? null, originSelected);

  return {
    id,
    title,
    createdAt: now,
    updatedAt: now,
    messages: [],
    originPageId: input.originPageId ?? null,
    originSelected: input.originSelectedIds ?? [],
  };
}

export function getSession(id: string): Session | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
  if (!row) return null;
  return rowToSession(readRow(row as Record<string, unknown>));
}

export function updateSession(id: string, input: UpdateSessionInput): Session | null {
  const db = getDb();
  const existing = getSession(id);
  if (!existing) return null;

  const now = Date.now();
  const title = input.title?.trim() ? input.title.trim().slice(0, 200) : existing.title;
  const messagesJson = input.messages ? JSON.stringify(input.messages) : JSON.stringify(existing.messages);

  // Single transaction: update sessions row + replace session_blocks for this
  // session if a fresh set was supplied. Replace-all is simpler than diffing
  // and the cardinality per session is small (tens, not thousands).
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE sessions SET title = ?, updated_at = ?, messages_json = ? WHERE id = ?`
    ).run(title, now, messagesJson, id);

    if (input.blockRefs) {
      db.prepare("DELETE FROM session_blocks WHERE session_id = ?").run(id);
      const insert = db.prepare(
        `INSERT OR IGNORE INTO session_blocks (session_id, block_id, source, touched_at)
         VALUES (?, ?, ?, ?)`
      );
      for (const ref of input.blockRefs) {
        insert.run(id, ref.blockId, ref.source, now);
      }
    }
  });
  tx();

  return getSession(id);
}

export function deleteSession(id: string): boolean {
  const db = getDb();
  const info = db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  return info.changes > 0;
}

export function listSessions(opts: { limit?: number; offset?: number } = {}): SessionListItem[] {
  const db = getDb();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const rows = db
    .prepare(
      `SELECT id, title, created_at, updated_at, messages_json FROM sessions
       ORDER BY updated_at DESC LIMIT ? OFFSET ?`
    )
    .all(limit, offset) as Array<{
    id: string;
    title: string;
    created_at: number;
    updated_at: number;
    messages_json: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    preview: previewFromMessagesJson(row.messages_json),
  }));
}

function previewFromMessagesJson(json: string): string {
  try {
    const arr = JSON.parse(json) as Array<{ role: string; parts?: Array<{ type: string; text?: string }> }>;
    const firstUser = arr.find((m) => m.role === "user");
    if (!firstUser) return "";
    const textPart = firstUser.parts?.find((p) => p.type === "text" && typeof p.text === "string");
    const raw = textPart?.text ?? "";
    // Strip the contextual preamble that `buildContextMessage` prepends to
    // every user prompt (`"I'm looking at block ID..."` / `"I've selected N
    // items..."` followed by `"Then:\n\n${userTaskOrInput}"`). The actual
    // user intent comes after the last `"Then:\n\n"` marker — surface THAT
    // in previews so the picker shows useful titles, not 100 chars of
    // boilerplate identical to every other session.
    const marker = "Then:\n\n";
    const idx = raw.lastIndexOf(marker);
    const useful = idx >= 0 ? raw.slice(idx + marker.length) : raw;
    return useful.trim().slice(0, 100);
  } catch {
    return "";
  }
}

export function listSessionsByBlock(blockId: string, limit = 20): SessionListItem[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT s.id, s.title, s.created_at, s.updated_at, s.messages_json
       FROM sessions s
       INNER JOIN (
         SELECT session_id, MAX(touched_at) AS most_recent
         FROM session_blocks
         WHERE block_id = ?
         GROUP BY session_id
       ) sb ON sb.session_id = s.id
       ORDER BY sb.most_recent DESC
       LIMIT ?`
    )
    .all(blockId, Math.min(Math.max(limit, 1), 100)) as Array<{
    id: string;
    title: string;
    created_at: number;
    updated_at: number;
    messages_json: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    preview: previewFromMessagesJson(row.messages_json),
  }));
}

export function getSessionBlocks(sessionId: string): SessionBlockRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT session_id, block_id, source, touched_at FROM session_blocks
       WHERE session_id = ? ORDER BY touched_at DESC`
    )
    .all(sessionId) as Array<{
    session_id: string;
    block_id: string;
    source: SessionBlockSource;
    touched_at: number;
  }>;
  return rows.map((r) => ({
    sessionId: r.session_id,
    blockId: r.block_id,
    source: r.source,
    touchedAt: r.touched_at,
  }));
}
