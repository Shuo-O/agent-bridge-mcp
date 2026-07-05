import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export function databasePath(cwd = process.cwd(), env = process.env) {
  return resolve(cwd, env.AGENT_BRIDGE_DB || ".agent-bridge/bridge.sqlite");
}

export function openDatabase(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      agent TEXT NOT NULL CHECK (agent IN ('claude', 'codex')),
      session_key TEXT NOT NULL,
      cwd TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      worker_pid INTEGER,
      timeout_seconds INTEGER NOT NULL,
      auth_mode TEXT NOT NULL DEFAULT 'subscription' CHECK (auth_mode IN ('subscription', 'api')),
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      duration_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS tasks_cwd_created ON tasks(cwd, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS tasks_one_active_session
      ON tasks(agent, session_key, cwd)
      WHERE status IN ('queued', 'running', 'cancelling');
    CREATE TABLE IF NOT EXISTS sessions (
      agent TEXT NOT NULL,
      session_key TEXT NOT NULL,
      cwd TEXT NOT NULL,
      session_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(agent, session_key, cwd)
    );
  `);
  const taskColumns = db.prepare("PRAGMA table_info(tasks)").all().map(column => column.name);
  if (!taskColumns.includes("auth_mode")) {
    db.exec("ALTER TABLE tasks ADD COLUMN auth_mode TEXT NOT NULL DEFAULT 'subscription'");
  }
  return db;
}

export function createTask(db, agent, args) {
  if (!['claude', 'codex'].includes(agent)) throw new Error(`Unsupported agent: ${agent}`);
  if (typeof args.prompt !== "string" || !args.prompt.trim()) throw new Error("prompt must be a non-empty string");
  const cwd = resolve(args.cwd || process.cwd());
  const id = randomUUID();
  const sessionKey = args.session_key?.trim() || `task:${id}`;
  const timeout = Math.min(Math.max(Math.round(args.timeout_seconds || 300), 10), 1800);
  const authMode = args.auth_mode || "subscription";
  if (!['subscription', 'api'].includes(authMode)) throw new Error("auth_mode must be subscription or api");
  try {
    db.prepare(`INSERT INTO tasks
      (id, agent, session_key, cwd, prompt, status, timeout_seconds, auth_mode, created_at)
      VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)`)
      .run(id, agent, sessionKey, cwd, args.prompt.trim(), timeout, authMode, new Date().toISOString());
  } catch (error) {
    if (String(error.message).includes("UNIQUE constraint failed")) {
      throw new Error(`Session '${sessionKey}' already has an active ${agent} task`);
    }
    throw error;
  }
  return getTask(db, id);
}

export function getTask(db, id) {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) || null;
}

export function listTasks(db, { cwd, limit = 20 } = {}) {
  const bounded = Math.min(Math.max(Number(limit) || 20, 1), 100);
  if (cwd) return db.prepare("SELECT * FROM tasks WHERE cwd = ? ORDER BY created_at DESC LIMIT ?").all(resolve(cwd), bounded);
  return db.prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?").all(bounded);
}

export function searchResearch(db, { query: text = "", cwd, limit = 10 } = {}) {
  const bounded = Math.min(Math.max(Number(limit) || 10, 1), 50);
  const query = `%${String(text).replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
  const params = cwd ? [resolve(cwd), query, query, bounded] : [query, query, bounded];
  const where = cwd ? "cwd = ? AND " : "";
  return db.prepare(`SELECT id, agent, session_key, cwd, prompt, result, created_at, completed_at
    FROM tasks WHERE ${where}status = 'completed' AND (prompt LIKE ? ESCAPE '\\' OR result LIKE ? ESCAPE '\\')
    ORDER BY completed_at DESC LIMIT ?`).all(...params);
}

export function getSession(db, agent, sessionKey, cwd) {
  return db.prepare("SELECT session_id FROM sessions WHERE agent = ? AND session_key = ? AND cwd = ?")
    .get(agent, sessionKey, cwd)?.session_id || null;
}

export function saveSession(db, agent, sessionKey, cwd, sessionId) {
  db.prepare(`INSERT INTO sessions(agent, session_key, cwd, session_id, updated_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(agent, session_key, cwd)
    DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at`)
    .run(agent, sessionKey, cwd, sessionId, new Date().toISOString());
}

export function publicTask(task, includeResult = false) {
  if (!task) return null;
  const value = {
    id: task.id, agent: task.agent, session_key: task.session_key, cwd: task.cwd,
    status: task.status, auth_mode: task.auth_mode, error: task.error, created_at: task.created_at,
    started_at: task.started_at, completed_at: task.completed_at, duration_ms: task.duration_ms
  };
  if (includeResult) value.result = task.result;
  return value;
}
