import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { resolve } from "node:path";
import { databasePath, getTask, openDatabase } from "../src/database.mjs";

if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is required for this confirmed fallback test");
const cwd = resolve(process.cwd());
const server = spawn(process.execPath, [resolve(cwd, "src/server.mjs")], {
  cwd, env: { ...process.env, AGENT_BRIDGE_CALLER: "codex", AGENT_BRIDGE_ENABLE_API_FALLBACK: "1" }, stdio: ["pipe", "pipe", "inherit"]
});
const lines = readline.createInterface({ input: server.stdout, crlfDelay: Infinity });
const responses = new Map();
const requests = [];
let wakeRequest;
lines.on("line", line => {
  const message = JSON.parse(line);
  if (message.method) { requests.push(message); wakeRequest?.(); wakeRequest = undefined; return; }
  const waiter = responses.get(message.id);
  if (waiter) { responses.delete(message.id); waiter(message); }
});
function request(id, method, params = {}) {
  const response = new Promise(resolveResponse => responses.set(id, resolveResponse));
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return response;
}
async function nextServerRequest(method) {
  while (true) {
    const index = requests.findIndex(message => message.method === method);
    if (index >= 0) return requests.splice(index, 1)[0];
    await new Promise(resolveRequest => { wakeRequest = resolveRequest; });
  }
}
async function waitForTask(id, acceptedStatuses, timeoutMs = 330_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const db = openDatabase(databasePath(cwd));
    const task = getTask(db, id);
    db.close();
    if (acceptedStatuses.includes(task?.status)) return task;
    await new Promise(resolveWait => setTimeout(resolveWait, 500));
  }
  throw new Error(`Task ${id} did not reach ${acceptedStatuses.join("/")}`);
}

try {
  await request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: { elicitation: {} }, clientInfo: { name: "fallback-e2e", version: "1" } });
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const delegated = await request(2, "tools/call", { name: "delegate_to_claude", arguments: {
    prompt: "Reply with exactly CLAUDE_FALLBACK_OK and nothing else.", cwd, timeout_seconds: 300
  } });
  assert.ok(!delegated.result.isError, delegated.result.content?.[0]?.text);
  const taskId = JSON.parse(delegated.result.content[0].text).id;
  const blocked = await waitForTask(taskId, ["awaiting_api_confirmation", "completed", "failed"]);
  if (blocked.status === "completed") {
    assert.match(blocked.result, /CLAUDE_FALLBACK_OK/);
    process.stdout.write(`${JSON.stringify({ task_id: taskId, backend: "subscription", status: "passed" }, null, 2)}\n`);
  } else {
    assert.equal(blocked.status, "awaiting_api_confirmation", blocked.error);
    const retryPromise = request(3, "tools/call", { name: "retry_task_with_api", arguments: { task_id: taskId } });
    const elicitation = await nextServerRequest("elicitation/create");
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: elicitation.id, result: {
      action: "accept", content: { confirm: true }
    } })}\n`);
    const retry = await retryPromise;
    assert.ok(!retry.result.isError, retry.result.content?.[0]?.text);
    const finished = await waitForTask(taskId, ["completed", "failed", "timed_out"]);
    assert.equal(finished.status, "completed", finished.error);
    assert.match(finished.result, /CLAUDE_FALLBACK_OK/);
    process.stdout.write(`${JSON.stringify({ task_id: taskId, backend: "api", status: "passed", duration_ms: finished.duration_ms }, null, 2)}\n`);
  }
} finally {
  server.stdin.end();
  await new Promise(resolveClose => server.once("close", resolveClose));
}
