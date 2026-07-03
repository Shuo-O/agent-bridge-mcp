import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import readline from "node:readline";
import { delegate } from "./runner.mjs";

const protocolVersion = "2025-06-18";
let queue = Promise.resolve();

const tools = [
  {
    name: "ask_claude",
    description: "Delegate read-only research, architecture review, or debugging analysis to Claude Code. Do not call this from a Claude delegate.",
    inputSchema: delegationSchema()
  },
  {
    name: "ask_codex",
    description: "Delegate read-only research, code review, or a second opinion to Codex. Do not call this from a Codex delegate.",
    inputSchema: delegationSchema()
  },
  {
    name: "get_research_log",
    description: "Read recent local delegation results shared by Codex and Claude Code.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Project directory; defaults to the MCP server working directory." },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 5 }
      },
      additionalProperties: false
    }
  }
];

function delegationSchema() {
  return {
    type: "object",
    properties: {
      prompt: { type: "string", minLength: 1, description: "Self-contained research or review request." },
      cwd: { type: "string", description: "Project directory; defaults to the MCP server working directory." },
      timeout_seconds: { type: "number", minimum: 1, maximum: 900, default: 180 }
    },
    required: ["prompt"],
    additionalProperties: false
  };
}

async function recentLog(args = {}) {
  const cwd = args.cwd || process.cwd();
  const limit = Math.min(Math.max(args.limit || 5, 1), 20);
  try {
    const text = await readFile(resolve(cwd, process.env.AGENT_BRIDGE_LOG || ".agent-bridge/research.jsonl"), "utf8");
    return text.trim().split("\n").slice(-limit).join("\n");
  } catch (error) {
    if (error.code === "ENOENT") return "No delegation research has been recorded yet.";
    throw error;
  }
}

async function callTool(name, args) {
  if (name === "ask_claude") return delegate("claude", args || {});
  if (name === "ask_codex") return delegate("codex", args || {});
  if (name === "get_research_log") return recentLog(args);
  throw new Error(`Unknown tool: ${name}`);
}

async function handle(message) {
  if (message.method === "notifications/initialized") return null;
  if (message.method === "initialize") {
    return {
      protocolVersion: message.params?.protocolVersion || protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "agent-bridge-mcp", version: "0.1.0" },
      instructions: "Use ask_claude from Codex and ask_codex from Claude Code for read-only delegation. Never ask a delegate to call back into this bridge. Delegations are serialized and locally logged."
    };
  }
  if (message.method === "tools/list") return { tools };
  if (message.method === "tools/call") {
    try {
      const text = await callTool(message.params?.name, message.params?.arguments);
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { content: [{ type: "text", text: error.message }], isError: true };
    }
  }
  if (message.id !== undefined) throw new Error(`Method not found: ${message.method}`);
  return null;
}

export async function processMessage(message) {
  try {
    const result = await handle(message);
    if (message.id === undefined || result === null) return null;
    return { jsonrpc: "2.0", id: message.id, result };
  } catch (error) {
    if (message.id === undefined) return null;
    return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: error.message } };
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", line => {
    queue = queue.then(async () => {
      if (!line.trim()) return;
      let message;
      try { message = JSON.parse(line); }
      catch { return; }
      const response = await processMessage(message);
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    }).catch(error => process.stderr.write(`${error.stack || error}\n`));
  });
}
