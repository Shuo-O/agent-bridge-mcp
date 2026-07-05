import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, createTask, getTask, saveSession } from "../src/database.mjs";
import { runTask } from "../src/worker.mjs";

test("worker completes a task and stores its session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-worker-"));
  const path = join(dir, "state.sqlite");
  const db = openDatabase(path);
  const task = createTask(db, "claude", { prompt: "hello", cwd: dir, session_key: "topic" });
  db.close();
  await runTask(path, task.id, { run: async (_agent, input) => {
    assert.equal(input.sessionId, null);
    return { result: "first answer", sessionId: "session-a" };
  }});
  const checked = openDatabase(path);
  assert.equal(getTask(checked, task.id).status, "completed");
  assert.equal(getTask(checked, task.id).result, "first answer");
  checked.close();
});

test("worker resumes the stored peer session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-resume-"));
  const path = join(dir, "state.sqlite");
  const db = openDatabase(path);
  saveSession(db, "codex", "topic", dir, "thread-old");
  const task = createTask(db, "codex", { prompt: "continue", cwd: dir, session_key: "topic" });
  db.close();
  await runTask(path, task.id, { run: async (_agent, input) => {
    assert.equal(input.sessionId, "thread-old");
    return { result: "continued", sessionId: "thread-old" };
  }});
  const checked = openDatabase(path);
  assert.equal(getTask(checked, task.id).status, "completed");
  checked.close();
});

test("worker records adapter failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-fail-"));
  const path = join(dir, "state.sqlite");
  const db = openDatabase(path);
  const task = createTask(db, "claude", { prompt: "fail", cwd: dir });
  db.close();
  await runTask(path, task.id, { run: async () => { throw new Error("adapter exploded"); } });
  const checked = openDatabase(path);
  assert.equal(getTask(checked, task.id).status, "failed");
  assert.match(getTask(checked, task.id).error, /adapter exploded/);
  checked.close();
});

test("worker requests API confirmation when subscription access is disabled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-auth-fallback-"));
  const path = join(dir, "state.sqlite");
  const db = openDatabase(path);
  const task = createTask(db, "claude", { prompt: "fallback", cwd: dir });
  db.close();
  await runTask(path, task.id, {
    env: { ...process.env, ANTHROPIC_API_KEY: "configured", AGENT_BRIDGE_ENABLE_API_FALLBACK: "1" },
    run: async () => { throw new Error("Your organization has disabled Claude subscription access for Claude Code"); }
  });
  const checked = openDatabase(path);
  assert.equal(getTask(checked, task.id).status, "awaiting_api_confirmation");
  checked.close();
});
