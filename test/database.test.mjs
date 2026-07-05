import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, createTask, getTask, saveSession, getSession, searchResearch, publicTask } from "../src/database.mjs";

test("creates tasks and persists resumable sessions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-db-"));
  const db = openDatabase(join(dir, "state.sqlite"));
  const task = createTask(db, "claude", { prompt: "inspect concurrency", cwd: dir, session_key: "review" });
  assert.equal(task.status, "queued");
  assert.equal(task.auth_mode, "subscription");
  assert.equal(task.session_key, "review");
  saveSession(db, "claude", "review", dir, "session-1");
  assert.equal(getSession(db, "claude", "review", dir), "session-1");
  assert.equal(publicTask(getTask(db, task.id)).result, undefined);
  db.close();
});

test("searches only completed research", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-search-"));
  const db = openDatabase(join(dir, "state.sqlite"));
  const task = createTask(db, "codex", { prompt: "race condition", cwd: dir });
  db.prepare("UPDATE tasks SET status='completed', result='mutex evidence', completed_at=? WHERE id=?")
    .run(new Date().toISOString(), task.id);
  assert.equal(searchResearch(db, { query: "mutex", cwd: dir }).length, 1);
  assert.equal(searchResearch(db, { query: "absent", cwd: dir }).length, 0);
  db.close();
});

test("rejects empty prompts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-invalid-"));
  const db = openDatabase(join(dir, "state.sqlite"));
  assert.throws(() => createTask(db, "claude", { prompt: " " }), /non-empty/);
  db.close();
});

test("prevents concurrent turns in the same peer session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-session-lock-"));
  const db = openDatabase(join(dir, "state.sqlite"));
  createTask(db, "claude", { prompt: "first", cwd: dir, session_key: "same" });
  assert.throws(() => createTask(db, "claude", { prompt: "second", cwd: dir, session_key: "same" }), /already has an active/);
  db.close();
});
