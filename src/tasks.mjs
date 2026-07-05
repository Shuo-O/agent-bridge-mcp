import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createTask, getTask, publicTask } from "./database.mjs";

const workerPath = fileURLToPath(new URL("./worker.mjs", import.meta.url));

function spawnWorker(task, dbPath, options = {}) {
  const childEnv = { ...(options.env || process.env), AI_AGENT_BRIDGE_DEPTH: "1" };
  if (task.auth_mode === "api") childEnv.AGENT_BRIDGE_API_CONFIRMATION = task.id;
  const child = spawn(process.execPath, [options.workerPath || workerPath, dbPath, task.id], {
    cwd: task.cwd, env: childEnv, detached: true, stdio: "ignore", shell: false
  });
  child.unref();
}

export function launchTask(db, dbPath, agent, args, options = {}) {
  const depth = Number((options.env || process.env).AI_AGENT_BRIDGE_DEPTH || 0);
  if (!Number.isInteger(depth) || depth >= 1) throw new Error("Nested delegation is blocked to prevent recursive loops");
  if (args.auth_mode === "api" && (options.env || process.env).AGENT_BRIDGE_ENABLE_API_FALLBACK !== "1") {
    throw new Error("API fallback is disabled; subscription-only mode is active");
  }
  const task = createTask(db, agent, args);
  if (task.auth_mode === "api" && options.apiApproved !== true) {
    db.prepare("DELETE FROM tasks WHERE id = ?").run(task.id);
    throw new Error("API mode requires an explicit confirmation for this invocation");
  }
  spawnWorker(task, dbPath, options);
  return publicTask(task);
}

export function retryTaskWithApi(db, dbPath, id, options = {}) {
  const task = getTask(db, id);
  if (!task) throw new Error(`Task not found: ${id}`);
  if (task.status !== "awaiting_api_confirmation") {
    throw new Error(`Task ${id} is not awaiting API confirmation`);
  }
  if (options.apiApproved !== true) throw new Error("API retry requires an explicit confirmation for this invocation");
  const env = options.env || process.env;
  if (env.AGENT_BRIDGE_ENABLE_API_FALLBACK !== "1") throw new Error("API fallback is disabled; subscription-only mode is active");
  const requiredKey = task.agent === "claude" ? env.ANTHROPIC_API_KEY : (env.CODEX_API_KEY || env.OPENAI_API_KEY);
  if (!requiredKey) throw new Error(`No API key is configured for ${task.agent}`);
  db.prepare(`UPDATE tasks SET auth_mode = 'api', status = 'queued', error = NULL,
    worker_pid = NULL, started_at = NULL, completed_at = NULL, duration_ms = NULL WHERE id = ?`).run(id);
  const updated = getTask(db, id);
  spawnWorker(updated, dbPath, { ...options, env });
  return publicTask(updated);
}

export function cancelTask(db, id) {
  const task = getTask(db, id);
  if (!task) throw new Error(`Task not found: ${id}`);
  if (["completed", "failed", "cancelled", "timed_out"].includes(task.status)) return publicTask(task);
  if (["queued", "awaiting_api_confirmation"].includes(task.status) && !task.worker_pid) {
    db.prepare("UPDATE tasks SET status = 'cancelled', completed_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
    return publicTask(getTask(db, id));
  }
  if (task.worker_pid) {
    try { process.kill(Number(task.worker_pid), "SIGTERM"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  db.prepare("UPDATE tasks SET status = 'cancelling' WHERE id = ?").run(id);
  return publicTask(getTask(db, id));
}
