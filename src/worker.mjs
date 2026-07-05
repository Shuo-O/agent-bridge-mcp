import { openDatabase, getTask, getSession, saveSession } from "./database.mjs";
import { runAgent } from "./adapters.mjs";

export async function runTask(dbPath, taskId, { run = runAgent, env = process.env } = {}) {
  const db = openDatabase(dbPath);
  const task = getTask(db, taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  if (task.status === "cancelled") { db.close(); return; }
  const started = Date.now();
  db.prepare("UPDATE tasks SET status = 'running', worker_pid = ?, started_at = ? WHERE id = ?")
    .run(process.pid, new Date().toISOString(), taskId);

  const controller = new AbortController();
  let cancelled = false;
  const cancel = () => { cancelled = true; controller.abort(new Error("Task cancelled")); };
  process.once("SIGTERM", cancel);
  process.once("SIGINT", cancel);
  const timer = setTimeout(() => controller.abort(new Error("Task timed out")), task.timeout_seconds * 1000);

  try {
    const sessionId = getSession(db, task.agent, task.session_key, task.cwd);
    const output = await run(task.agent, {
      prompt: task.prompt, cwd: task.cwd, sessionId, signal: controller.signal,
      taskId: task.id, authMode: task.auth_mode, env
    });
    if (cancelled) throw new Error("Task cancelled");
    saveSession(db, task.agent, task.session_key, task.cwd, output.sessionId);
    db.prepare(`UPDATE tasks SET status = 'completed', result = ?, completed_at = ?, duration_ms = ? WHERE id = ?`)
      .run(output.result.slice(0, 100_000), new Date().toISOString(), Date.now() - started, taskId);
  } catch (error) {
    const subscriptionBlocked = task.agent === "claude" && task.auth_mode === "subscription" &&
      /disabled Claude subscription access/i.test(String(error?.message || error)) &&
      env.AGENT_BRIDGE_ENABLE_API_FALLBACK === "1" && Boolean(env.ANTHROPIC_API_KEY);
    const status = subscriptionBlocked ? "awaiting_api_confirmation" :
      cancelled ? "cancelled" : controller.signal.aborted ? "timed_out" : "failed";
    db.prepare(`UPDATE tasks SET status = ?, error = ?, completed_at = ?, duration_ms = ? WHERE id = ?`)
      .run(status, String(error?.message || error).slice(0, 10_000), new Date().toISOString(), Date.now() - started, taskId);
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGTERM", cancel);
    process.removeListener("SIGINT", cancel);
    db.close();
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [, , dbPath, taskId] = process.argv;
  runTask(dbPath, taskId).catch(error => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
}
