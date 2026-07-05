import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { resolve } from "node:path";
import { openDatabase, databasePath, getTask } from "../src/database.mjs";

const cwd = resolve(process.cwd());
const child = spawn(process.execPath, [resolve(cwd, "src/server.mjs")], {
  cwd,
  env: { ...process.env, AGENT_BRIDGE_CALLER: "claude" },
  stdio: ["pipe", "pipe", "inherit"]
});
const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
const responses = new Map();
lines.on("line", line => {
  const message = JSON.parse(line);
  const waiter = responses.get(message.id);
  if (waiter) { responses.delete(message.id); waiter(message); }
});
function request(id, method, params = {}) {
  const result = new Promise(resolvePromise => responses.set(id, resolvePromise));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return result;
}

await request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
const called = await request(2, "tools/call", {
  name: "delegate_to_codex",
  arguments: { prompt: "Reply with exactly MCP_ASYNC_OK and nothing else.", cwd, timeout_seconds: 300 }
});
assert.ok(!called.result.isError, called.result.content?.[0]?.text);
const taskId = JSON.parse(called.result.content[0].text).id;
child.stdin.end();
await new Promise(resolvePromise => child.once("close", resolvePromise));

const deadline = Date.now() + 310_000;
let task;
while (Date.now() < deadline) {
  const db = openDatabase(databasePath(cwd));
  task = getTask(db, taskId);
  db.close();
  if (["completed", "failed", "cancelled", "timed_out"].includes(task?.status)) break;
  await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
}
assert.equal(task?.status, "completed", task?.error || "task did not reach a terminal state");
assert.match(task.result, /MCP_ASYNC_OK/);
process.stdout.write(`${JSON.stringify({ task_id: taskId, status: task.status, duration_ms: task.duration_ms }, null, 2)}\n`);
