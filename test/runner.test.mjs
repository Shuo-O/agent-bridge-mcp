import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildInvocation, delegate, parseClaude, parseCodex } from "../src/runner.mjs";

test("buildInvocation disables bridge MCP and uses read-only modes", () => {
  const claude = buildInvocation("claude", "/tmp");
  assert.ok(claude.args.includes("--strict-mcp-config"));
  assert.ok(claude.args.includes("dontAsk"));
  const codex = buildInvocation("codex", "/tmp");
  assert.ok(codex.args.includes("read-only"));
  assert.ok(codex.args.includes("mcp_servers={}"));
});

test("parses native CLI output formats", () => {
  assert.equal(parseClaude('{"result":"hello","is_error":false}'), "hello");
  assert.equal(parseCodex('{"type":"item.completed","item":{"type":"agent_message","text":"world"}}\n'), "world");
});

test("blocks recursive delegation", async () => {
  await assert.rejects(
    delegate("claude", { prompt: "hello" }, { env: { ...process.env, AI_AGENT_BRIDGE_DEPTH: "1" } }),
    /recursive loops/
  );
});

test("delegates through argv without shell interpolation and records research", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-bridge-"));
  const stub = join(dir, "fake-claude.mjs");
  await writeFile(stub, '#!/usr/bin/env node\nlet s=""; for await (const c of process.stdin) s+=c; process.stdout.write(JSON.stringify({result:s.includes("$(touch nope)") ? "safe" : "missing",is_error:false}));\n');
  await chmod(stub, 0o755);
  const result = await delegate("claude", { prompt: "$(touch nope)", cwd: dir }, {
    env: { ...process.env, AGENT_BRIDGE_CLAUDE_BIN: stub }
  });
  assert.equal(result, "safe");
  const log = await readFile(join(dir, ".agent-bridge/research.jsonl"), "utf8");
  assert.match(log, /\$\(touch nope\)/);
});

test("terminates a timed-out delegate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-bridge-timeout-"));
  const stub = join(dir, "slow.mjs");
  await writeFile(stub, '#!/usr/bin/env node\nsetTimeout(()=>process.stdout.write("{}"), 10000);\n');
  await chmod(stub, 0o755);
  await assert.rejects(
    delegate("claude", { prompt: "wait", cwd: dir, timeout_seconds: 0.05 }, {
      env: { ...process.env, AGENT_BRIDGE_CLAUDE_BIN: stub }
    }),
    /positive number|terminated/
  );
});
