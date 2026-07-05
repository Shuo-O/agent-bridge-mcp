import test from "node:test";
import assert from "node:assert/strict";

test("Codex caller sees only Claude delegation", async () => {
  process.env.AGENT_BRIDGE_CALLER = "codex";
  const { processMessage } = await import(`../src/server.mjs?codex=${Date.now()}`);
  const response = await processMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const names = response.result.tools.map(tool => tool.name);
  assert.ok(names.includes("delegate_to_claude"));
  assert.ok(!names.includes("delegate_to_codex"));
});

test("Claude caller sees only Codex delegation", async () => {
  process.env.AGENT_BRIDGE_CALLER = "claude";
  const { processMessage } = await import(`../src/server.mjs?claude=${Date.now()}`);
  const response = await processMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const names = response.result.tools.map(tool => tool.name);
  assert.ok(names.includes("delegate_to_codex"));
  assert.ok(!names.includes("delegate_to_claude"));
  assert.ok(names.includes("continue_peer_session"));
  assert.ok(names.includes("search_research"));
  assert.ok(!names.includes("retry_task_with_api"));
});

test("API fallback tools appear only after explicit server opt-in", async () => {
  process.env.AGENT_BRIDGE_CALLER = "codex";
  process.env.AGENT_BRIDGE_ENABLE_API_FALLBACK = "1";
  const { processMessage } = await import(`../src/server.mjs?api=${Date.now()}`);
  const response = await processMessage({ jsonrpc: "2.0", id: 4, method: "tools/list" });
  const names = response.result.tools.map(tool => tool.name);
  assert.ok(names.includes("retry_task_with_api"));
  delete process.env.AGENT_BRIDGE_ENABLE_API_FALLBACK;
});

test("initialize advertises asynchronous workflow", async () => {
  const { processMessage } = await import(`../src/server.mjs?init=${Date.now()}`);
  const response = await processMessage({ jsonrpc: "2.0", id: 3, method: "initialize", params: {} });
  assert.equal(response.result.serverInfo.version, "0.2.0");
  assert.match(response.result.instructions, /asynchronous/);
});
