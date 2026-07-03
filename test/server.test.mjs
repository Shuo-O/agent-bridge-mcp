import test from "node:test";
import assert from "node:assert/strict";
import { processMessage } from "../src/server.mjs";

test("MCP initialize and tool discovery", async () => {
  const init = await processMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(init.result.serverInfo.name, "agent-bridge-mcp");
  const listed = await processMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(listed.result.tools.map(tool => tool.name), ["ask_claude", "ask_codex", "get_research_log"]);
});

test("unknown MCP methods return JSON-RPC errors", async () => {
  const response = await processMessage({ jsonrpc: "2.0", id: 3, method: "missing" });
  assert.equal(response.error.code, -32601);
});
