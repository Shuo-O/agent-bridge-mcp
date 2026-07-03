# Agent Bridge MCP

在 Codex 与 Claude Code 当前会话里直接委派只读调研，不再手动切换终端。

Agent Bridge 是一个零运行时依赖的本地 stdio MCP server，向两端提供：

- `ask_claude`：Codex 调用 Claude Code 做调研、架构审阅或调试分析。
- `ask_codex`：Claude Code 调用 Codex 做调研、代码审阅或第二意见。
- `get_research_log`：读取双方最近的委派结果。

## 为什么不直接互相注册原生 MCP server？

Claude Code 的 `claude mcp serve` 和 Codex 的 `codex mcp-server` 暴露各自的文件、命令等底层工具。它们适合让另一个 MCP client 操作工具，但不直接提供“让另一个完整 agent 独立完成一轮调研”的统一调用。Agent Bridge 使用两端官方非交互模式，补上 agent-to-agent 委派、断环、超时、只读权限和共享记录。

## 使用

要求 Node.js 20+，并已安装、登录 `claude` 与 `codex` CLI。

```bash
git clone https://github.com/Shuo-O/agent-bridge-mcp.git
cd agent-bridge-mcp
npm test
```

仓库已包含两端项目级配置：

- Claude Code：`.mcp.json`
- Codex CLI/App：`.codex/config.toml`

在仓库根目录启动任一客户端并信任项目配置。之后可直接说：

```text
请调用 ask_claude，调研这个模块的并发风险并给出证据。
请调用 ask_codex，复核这个修复是否覆盖了根因。
读取 get_research_log，总结双方意见的共同点和分歧。
```

也可把服务注册为用户级 MCP，从任意项目使用：

```bash
claude mcp add --scope user agent-bridge -- node /absolute/path/agent-bridge-mcp/src/server.mjs
codex mcp add agent-bridge -- node /absolute/path/agent-bridge-mcp/src/server.mjs
```

用户级使用时，调用工具要传目标项目的绝对 `cwd`。

## 安全边界

- 委派进程默认只读：Claude 仅启用读取/搜索工具，Codex 使用 `read-only` sandbox。
- 子进程不加载此 MCP bridge，且 `AI_AGENT_BRIDGE_DEPTH` 阻止嵌套委派。
- 调用串行执行，默认超时 180 秒、最大 900 秒，输出最多 50,000 字符。
- prompt 通过 stdin 传递，子进程使用 argv 数组且不开 shell。
- 结果写入 `.agent-bridge/research.jsonl`，该目录默认不入 Git。日志可能包含敏感上下文，请按需清理。

## 配置

环境变量：

| 变量 | 用途 |
|---|---|
| `AGENT_BRIDGE_CLAUDE_BIN` | 覆盖 `claude` 可执行文件，主要用于测试 |
| `AGENT_BRIDGE_CODEX_BIN` | 覆盖 `codex` 可执行文件 |
| `AGENT_BRIDGE_LOG` | 相对 `cwd` 或绝对日志路径 |

## 开发

```bash
npm test
node src/server.mjs
```

服务按 MCP stdio 约定仅向 stdout 输出 JSON-RPC，诊断写 stderr。

## 限制

- 当前每次委派是独立的非交互会话，不延续被调方历史会话。
- 双方需要各自有效的 CLI 登录态，调用会产生相应模型用量。
- 共享日志是本机项目级同步，不是跨设备数据库。

设计调研与取舍见 [docs/RESEARCH.md](docs/RESEARCH.md)。
