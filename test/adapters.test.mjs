import test from "node:test";
import assert from "node:assert/strict";
import { delegatedEnv, runLmStudio } from "../src/adapters.mjs";

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

test("LM Studio backend calls local OpenAI-compatible chat endpoint", async () => {
  const calls = [];
  const output = await runLmStudio({
    prompt: "Reply exactly LOCAL_OK",
    cwd: "/tmp/project",
    taskId: "task-1",
    env: {
      AGENT_BRIDGE_LMSTUDIO_BASE_URL: "http://127.0.0.1:1234/v1",
      AGENT_BRIDGE_LMSTUDIO_MODEL: "peer-agent"
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: "LOCAL_OK" } }] })
      };
    }
  });
  assert.equal(output.result, "LOCAL_OK");
  assert.equal(output.sessionId, "lmstudio:peer-agent");
  assert.equal(calls[0].url, "http://127.0.0.1:1234/v1/chat/completions");
  assert.equal(calls[0].body.model, "peer-agent");
  assert.match(calls[0].body.messages[1].content, /Reply exactly LOCAL_OK/);
});
