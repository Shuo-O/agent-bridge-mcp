import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import readline from "node:readline";

test("API mode elicits confirmation and starts nothing when declined", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "bridge-elicit-"));
  const server = spawn(process.execPath, [resolve("src/server.mjs")], {
    cwd, env: { ...process.env, AGENT_BRIDGE_CALLER: "codex", AGENT_BRIDGE_ENABLE_API_FALLBACK: "1" }, stdio: ["pipe", "pipe", "inherit"]
  });
  const lines = readline.createInterface({ input: server.stdout, crlfDelay: Infinity });
  const messages = [];
  let wake;
  lines.on("line", line => { messages.push(JSON.parse(line)); wake?.(); wake = undefined; });
  const next = async predicate => {
    while (true) {
      const index = messages.findIndex(predicate);
      if (index >= 0) return messages.splice(index, 1)[0];
      await new Promise(resolvePromise => { wake = resolvePromise; });
    }
  };
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: { elicitation: {} } } })}\n`);
  await next(message => message.id === 1);
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
    name: "delegate_to_claude", arguments: { prompt: "paid", cwd, auth_mode: "api" }
  } })}\n`);
  const elicitation = await next(message => message.method === "elicitation/create");
  assert.match(elicitation.params.message, /may incur charges/);
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: elicitation.id, result: { action: "decline" } })}\n`);
  const response = await next(message => message.id === 2);
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /not confirmed/);
  server.stdin.end();
  await new Promise(resolvePromise => server.once("close", resolvePromise));
});
