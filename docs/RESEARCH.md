# 架构调研与决策

调研日期：2026-07-03。

## 需求拆解

目标不是只让两端读取同一份提示文件，而是：

1. 在 Codex 会话里直接请求 Claude Code 完成独立调研。
2. 在 Claude Code 会话里直接请求 Codex 完成独立调研。
3. 双方能读取之前的委派结果。
4. 不因互相可调用而形成递归进程/费用失控。
5. 保留各 CLI 已有登录态，不要求额外 API key 服务。

## 调研结果

### MCP 适合作为入口协议

Codex CLI/App 与 Claude Code 均支持本地 stdio MCP server，并支持项目级配置。MCP 因而可以把委派工具直接放入当前 agent 的工具列表，无需用户切换终端。

官方资料：

- [Codex MCP 配置](https://developers.openai.com/codex/mcp)
- [Claude Code MCP 配置](https://docs.anthropic.com/en/docs/claude-code/mcp)

### 两端均有稳定的非交互入口

- Claude Code：`claude -p --output-format json`，返回包含 `result` 与 `session_id` 的 JSON。
- Codex：`codex exec --json`，返回 JSONL 事件，可从最终 `agent_message` 提取回答。

官方资料：

- [Claude Code CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage)
- [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive)

### 原生 MCP server 不是完整替代

`claude mcp serve` 与 `codex mcp-server` 值得用于工具级组合，但它们暴露的是 agent 工具接口。当前需求需要稳定、对称的“完整调研委派”契约，以及统一的只读、日志、超时和递归策略，因此增加薄网关更合适。

## 选择

0.2 采用 Node.js stdio MCP server、官方 Agent SDK 与 SQLite：

```text
Codex ── delegate_to_claude ─┐
                             ├─ Agent Bridge ─ detached worker ─ Agent SDK
Claude ── delegate_to_codex ─┘             └─ SQLite tasks/sessions/research
```

网关不保存凭据；它负责协议适配、异步任务、会话 ID 映射与研究索引。模型认证仍由两端官方 SDK/CLI 管理。

## 风险控制

| 风险 | 控制 |
|---|---|
| A 调 B、B 再调 A | 子进程清空 bridge MCP 配置 + 深度环境变量上限 1 |
| 同时写同一工作区 | 两种委派均强制只读 |
| prompt 命令注入 | stdin 传 prompt、`spawn` argv、`shell: false` |
| 僵尸/费用失控 | 串行队列、超时 SIGTERM/SIGKILL、输出上限 |
| 结果无法同步 | 项目本地 JSONL + `get_research_log` |
| 日志泄密 | 0600 文件、Git 忽略；仍需用户主动控制敏感 prompt |

## Claude Code 架构复核

实现前通过本机 Claude Code 只读审阅。复核确认自定义 MCP wrapper 可行，认为其核心价值在统一递归防护、超时、权限与日志，并建议：被调子进程禁用 bridge、深度计数、只读权限、无 shell argv、受控输出及真实冒烟测试。本实现采纳了这些建议。
