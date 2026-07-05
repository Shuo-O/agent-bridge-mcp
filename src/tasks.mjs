import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createTask, getTask, publicTask } from "./database.mjs";

const workerPath = fileURLToPath(new URL("./worker.mjs", import.meta.url));

export function launchTask(db, dbPath, agent, args, options = {}) {
  const depth = Number((options.env || process.env).AI_AGENT_BRIDGE_DEPTH || 0);
  if (!Number.isInteger(depth) || depth >= 1) throw new Error("Nested delegation is blocked to prevent recursive loops");
  const task = createTask(db, agent, args);
  if (task.auth_mode === "api" && options.apiApproved !== true) {
    db.prepare("DELETE FROM tasks WHERE id = ?").run(task.id);
    throw new Error("API mode requires an explicit confirmation for this invocation");
  }
  const childEnv = { ...(options.env || process.env), AI_AGENT_BRIDGE_DEPTH: "1" };
  if (task.auth_mode === "api") childEnv.AGENT_BRIDGE_API_CONFIRMATION = task.id;
  const child = spawn(process.execPath, [options.workerPath || workerPath, dbPath, task.id], {
    cwd: task.cwd,
    env: childEnv,
    detached: true,
    stdio: "ignore",
    shell: false
  });
  child.unref();
  return publicTask(task);
}

export function cancelTask(db, id) {
  const task = getTask(db, id);
  if (!task) throw new Error(`Task not found: ${id}`);
  if (["completed", "failed", "cancelled", "timed_out"].includes(task.status)) return publicTask(task);
  if (task.status === "queued" && !task.worker_pid) {
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
