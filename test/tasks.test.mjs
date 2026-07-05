import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, createTask, getTask } from "../src/database.mjs";
import { cancelTask, launchTask } from "../src/tasks.mjs";

test("cancels a queued task without starting it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-cancel-"));
  const db = openDatabase(join(dir, "state.sqlite"));
  const task = createTask(db, "codex", { prompt: "queued", cwd: dir });
  const cancelled = cancelTask(db, task.id);
  assert.equal(cancelled.status, "cancelled");
  assert.ok(getTask(db, task.id).completed_at);
  db.close();
});

test("blocks nested delegation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-depth-"));
  const db = openDatabase(join(dir, "state.sqlite"));
  assert.throws(() => launchTask(db, join(dir, "state.sqlite"), "claude", { prompt: "nested", cwd: dir }, {
    env: { AI_AGENT_BRIDGE_DEPTH: "1" }
  }), /Nested delegation/);
  db.close();
});

test("rejects API tasks without invocation-specific approval", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-api-confirm-"));
  const path = join(dir, "state.sqlite");
  const db = openDatabase(path);
  assert.throws(() => launchTask(db, path, "claude", {
    prompt: "paid", cwd: dir, auth_mode: "api"
  }), /explicit confirmation/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, 0);
  db.close();
});

test("detached worker completes after the launcher returns", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-detached-"));
  const path = join(dir, "state.sqlite");
  const fakeWorker = join(dir, "fake-worker.mjs");
  await writeFile(fakeWorker, `
    import { DatabaseSync } from 'node:sqlite';
    const [, , dbPath, taskId] = process.argv;
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE tasks SET status='completed', result='detached-ok', completed_at=? WHERE id=?")
      .run(new Date().toISOString(), taskId);
    db.close();
  `);
  const db = openDatabase(path);
  const launched = launchTask(db, path, "codex", { prompt: "detached", cwd: dir }, { workerPath: fakeWorker });
  db.close();
  let task;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const checked = openDatabase(path);
    task = getTask(checked, launched.id);
    checked.close();
    if (task.status === "completed") break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(task.status, "completed");
  assert.equal(task.result, "detached-ok");
});
