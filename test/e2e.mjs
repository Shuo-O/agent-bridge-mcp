import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase, createTask, getTask, getSession } from "../src/database.mjs";
import { runTask } from "../src/worker.mjs";

const cwd = resolve(process.cwd());
const dbPath = resolve(cwd, ".agent-bridge/e2e.sqlite");
rmSync(dbPath, { force: true });
rmSync(`${dbPath}-shm`, { force: true });
rmSync(`${dbPath}-wal`, { force: true });

async function execute(agent, prompt, sessionKey) {
  const db = openDatabase(dbPath);
  const task = createTask(db, agent, { prompt, cwd, session_key: sessionKey, timeout_seconds: 300 });
  db.close();
  await runTask(dbPath, task.id);
  const checked = openDatabase(dbPath);
  const result = getTask(checked, task.id);
  const sessionId = getSession(checked, agent, sessionKey, cwd);
  checked.close();
  assert.equal(result.status, "completed", `${agent} failed: ${result.error}`);
  assert.ok(sessionId, `${agent} did not persist a session id`);
  return { task: result, sessionId };
}

const report = { started_at: new Date().toISOString(), node: process.version, cases: [] };
const agents = (process.env.AGENT_BRIDGE_E2E_AGENTS || "claude,codex").split(",").map(value => value.trim()).filter(Boolean);
for (const agent of agents) {
  const key = `e2e-${agent}`;
  const first = await execute(agent, "Reply with exactly BRIDGE_FIRST_OK and nothing else.", key);
  assert.match(first.task.result, /BRIDGE_FIRST_OK/);
  const second = await execute(agent, "Reply with exactly BRIDGE_RESUME_OK and nothing else.", key);
  assert.match(second.task.result, /BRIDGE_RESUME_OK/);
  assert.equal(second.sessionId, first.sessionId, `${agent} did not resume the same session`);
  report.cases.push({
    agent,
    first_task: first.task.id,
    resumed_task: second.task.id,
    session_id: first.sessionId,
    first_duration_ms: first.task.duration_ms,
    resumed_duration_ms: second.task.duration_ms,
    status: "passed"
  });
}
report.completed_at = new Date().toISOString();
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
