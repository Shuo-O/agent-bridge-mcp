import readline from "node:readline";
import { databasePath, openDatabase, getTask, listTasks, publicTask, searchResearch } from "./database.mjs";
import { launchTask, cancelTask } from "./tasks.mjs";

const protocolVersion = "2025-06-18";
const caller = process.env.AGENT_BRIDGE_CALLER || "both";
const dbPath = databasePath(process.cwd());
let queue = Promise.resolve();
const pendingClientResponses = new Map();
let nextServerRequestId = 1;
let transportReady = false;
let clientSupportsElicitation = false;

function taskSchema() {
  return {
    type: "object",
    properties: {
      prompt: { type: "string", minLength: 1 },
      cwd: { type: "string", description: "Absolute project directory; defaults to server cwd." },
      session_key: { type: "string", description: "Reuse this key to continue one peer conversation." },
      timeout_seconds: { type: "integer", minimum: 10, maximum: 1800, default: 300 },
      auth_mode: { type: "string", enum: ["subscription", "api"], default: "subscription", description: "API mode always triggers a fresh user confirmation." }
    }, required: ["prompt"], additionalProperties: false
  };
}

const peerTools = [];
if (caller === "codex" || caller === "both") peerTools.push({
  name: "delegate_to_claude", description: "Start an asynchronous read-only Claude Code research task.", inputSchema: taskSchema()
});
if (caller === "claude" || caller === "both") peerTools.push({
  name: "delegate_to_codex", description: "Start an asynchronous read-only Codex research task.", inputSchema: taskSchema()
});

const tools = [...peerTools,
  {
    name: "get_task_status", description: "Get delegation status without the potentially large result.",
    inputSchema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"], additionalProperties: false }
  },
  {
    name: "get_task_result", description: "Get delegation status and final result.",
    inputSchema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"], additionalProperties: false }
  },
  {
    name: "continue_peer_session", description: "Continue the same peer conversation associated with a previous task.",
    inputSchema: { type: "object", properties: {
      task_id: { type: "string" }, prompt: { type: "string", minLength: 1 },
      timeout_seconds: { type: "integer", minimum: 10, maximum: 1800, default: 300 }
    }, required: ["task_id", "prompt"], additionalProperties: false }
  },
  {
    name: "cancel_task", description: "Cancel a queued or running peer task.",
    inputSchema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"], additionalProperties: false }
  },
  {
    name: "search_research", description: "Search completed peer research stored in the local SQLite database.",
    inputSchema: { type: "object", properties: {
      query: { type: "string", default: "" }, cwd: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 50, default: 10 }
    }, additionalProperties: false }
  },
  {
    name: "list_tasks", description: "List recent delegation tasks.",
    inputSchema: { type: "object", properties: { cwd: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100 } }, additionalProperties: false }
  }
];

function respond(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

async function callTool(name, args = {}) {
  const db = openDatabase(dbPath);
  try {
    if (name === "delegate_to_claude") {
      const apiApproved = args.auth_mode === "api" ? await requestApiConfirmation("Claude") : false;
      return respond(launchTask(db, dbPath, "claude", args, { apiApproved }));
    }
    if (name === "delegate_to_codex") {
      const apiApproved = args.auth_mode === "api" ? await requestApiConfirmation("Codex") : false;
      return respond(launchTask(db, dbPath, "codex", args, { apiApproved }));
    }
    if (name === "get_task_status" || name === "get_task_result") {
      const task = getTask(db, args.task_id);
      if (!task) throw new Error(`Task not found: ${args.task_id}`);
      return respond(publicTask(task, name === "get_task_result"));
    }
    if (name === "continue_peer_session") {
      const previous = getTask(db, args.task_id);
      if (!previous) throw new Error(`Task not found: ${args.task_id}`);
      const apiApproved = previous.auth_mode === "api" ? await requestApiConfirmation(previous.agent === "claude" ? "Claude" : "Codex") : false;
      return respond(launchTask(db, dbPath, previous.agent, {
        prompt: args.prompt, cwd: previous.cwd, session_key: previous.session_key,
        timeout_seconds: args.timeout_seconds, auth_mode: previous.auth_mode
      }, { apiApproved }));
    }
    if (name === "cancel_task") return respond(cancelTask(db, args.task_id));
    if (name === "search_research") return respond(searchResearch(db, args));
    if (name === "list_tasks") return respond(listTasks(db, args).map(task => publicTask(task)));
    throw new Error(`Unknown or unavailable tool for caller ${caller}: ${name}`);
  } finally { db.close(); }
}

function requestApiConfirmation(agentName) {
  if (!transportReady) throw new Error("API mode requires an MCP client that supports interactive elicitation");
  if (!clientSupportsElicitation) throw new Error("This MCP client did not advertise elicitation support; API mode is disabled and no task was started");
  const id = `agent-bridge-confirm-${nextServerRequestId++}`;
  const request = {
    jsonrpc: "2.0", id, method: "elicitation/create", params: {
      mode: "form",
      message: `${agentName} subscription authentication is unavailable. Use the API key for this invocation only? This may incur charges.`,
      requestedSchema: {
        type: "object",
        properties: { confirm: { type: "boolean", title: "I approve API usage and possible charges for this invocation" } },
        required: ["confirm"]
      }
    }
  };
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      pendingClientResponses.delete(id);
      reject(new Error("API confirmation timed out; no task was started"));
    }, 120_000);
    pendingClientResponses.set(id, response => {
      clearTimeout(timer);
      if (response.error) return reject(new Error(`API confirmation failed: ${response.error.message}`));
      const approved = response.result?.action === "accept" && response.result?.content?.confirm === true;
      if (!approved) return reject(new Error("API use was not confirmed; no task was started"));
      resolvePromise(true);
    });
    process.stdout.write(`${JSON.stringify(request)}\n`);
  });
}

async function handle(message) {
  if (message.method === "notifications/initialized") return null;
  if (message.method === "initialize") {
    clientSupportsElicitation = message.params?.capabilities?.elicitation !== undefined;
    return {
      protocolVersion: message.params?.protocolVersion || protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "agent-bridge-mcp", version: "0.2.0" },
      instructions: "Delegate only to the opposite agent. Tasks are asynchronous: start one, poll get_task_status, then read get_task_result. Use continue_peer_session for follow-ups. Delegates are read-only and cannot call this bridge. Subscription auth is always preferred; API mode requires a new client elicitation confirmation for every invocation."
    };
  }
  if (message.method === "tools/list") return { tools };
  if (message.method === "tools/call") {
    try { return await callTool(message.params?.name, message.params?.arguments); }
    catch (error) { return { content: [{ type: "text", text: error.message }], isError: true }; }
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
  transportReady = true;
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", line => {
    let parsed;
    try { parsed = JSON.parse(line); } catch { return; }
    if (parsed.method === undefined && parsed.id !== undefined && pendingClientResponses.has(parsed.id)) {
      const resolveResponse = pendingClientResponses.get(parsed.id);
      pendingClientResponses.delete(parsed.id);
      resolveResponse(parsed);
      return;
    }
    queue = queue.then(async () => {
      const response = await processMessage(parsed);
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    }).catch(error => process.stderr.write(`${error.stack || error}\n`));
  });
}
