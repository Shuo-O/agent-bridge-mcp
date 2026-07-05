import test from "node:test";
import assert from "node:assert/strict";
import { delegatedEnv } from "../src/adapters.mjs";

test("subscription mode strips API keys to prevent surprise billing", () => {
  const claude = delegatedEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "secret", ANTHROPIC_AUTH_TOKEN: "token" }, "claude");
  assert.equal(claude.ANTHROPIC_API_KEY, undefined);
  assert.equal(claude.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(claude.AI_AGENT_BRIDGE_DEPTH, "1");
  const codex = delegatedEnv({ PATH: "/bin", OPENAI_API_KEY: "secret", CODEX_API_KEY: "token" }, "codex");
  assert.equal(codex.OPENAI_API_KEY, undefined);
  assert.equal(codex.CODEX_API_KEY, undefined);
});

test("API keys pass only after per-task approval", () => {
  const env = delegatedEnv({ ANTHROPIC_API_KEY: "secret" }, "claude", true);
  assert.equal(env.ANTHROPIC_API_KEY, "secret");
});
