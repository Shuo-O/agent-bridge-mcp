# Agent Bridge MCP

让 Codex 和 Claude Code 在当前会话中直接委派对方进行调研、复核和连续追问，无需切换终端。

Agent Bridge 0.2 使用本地 MCP 作为统一入口，以官方 Codex SDK 和 Claude Agent SDK 运行对侧 agent，并使用 SQLite 共享任务、会话和调研结果。

## 能力

- Codex 只看到 `delegate_to_claude`，Claude Code 只看到 `delegate_to_codex`。
- 调研异步运行，长任务不会占住 MCP 请求。
- `continue_peer_session` 延续同一 Codex thread 或 Claude session。
- `search_research` 在本地 SQLite 中检索双方历史结论。
- 支持任务状态、结果查询、列表与取消。
- 默认只读、禁用子 agent 的 MCP bridge，并阻止嵌套调用。
- 默认复用 CLI/订阅登录，主动移除 API key，避免意外按量计费；API 模式每次都要求 MCP 客户端弹窗确认。

## 要求

- Node.js 22.5+
- 已安装并登录的 Codex CLI
- 已安装并登录的 Claude Code

```bash
codex --version
claude --version
```

## 安装

```bash
git clone https://github.com/Shuo-O/agent-bridge-mcp.git
cd agent-bridge-mcp
npm install
npm test
```

项目已带两端配置：

- Codex：`.codex/config.toml`，设置 `AGENT_BRIDGE_CALLER=codex`
- Claude Code：`.mcp.json`，设置 `AGENT_BRIDGE_CALLER=claude`

在仓库根目录启动 Codex 或 Claude Code。首次启动时信任项目 MCP 配置；Claude Code 会明确要求批准 `.mcp.json`。

### 在其他项目使用

建议注册两个用户级别名，分别声明调用方：

```bash
codex mcp add agent-bridge \
  --env AGENT_BRIDGE_CALLER=codex \
  -- node /absolute/path/agent-bridge-mcp/src/server.mjs

claude mcp add --scope user agent-bridge \
  --env AGENT_BRIDGE_CALLER=claude \
  -- node /absolute/path/agent-bridge-mcp/src/server.mjs
```

调用时给 `cwd` 传目标项目绝对路径。数据库默认仍创建在 MCP server 启动目录的 `.agent-bridge/bridge.sqlite`。

## 使用流程

### Codex 调用 Claude

对 Codex 说：

```text
调用 delegate_to_claude，cwd 使用当前项目，调研认证模块的并发风险。
任务启动后轮询 get_task_status，完成后用 get_task_result 返回结论。
```

### Claude 调用 Codex

对 Claude Code 说：

```text
调用 delegate_to_codex，复核当前修复是否覆盖根因。
等待任务完成并返回结果。
```

### 连续追问

第一次委派返回 `task_id` 与 `session_key`。随后：

```text
使用 continue_peer_session，task_id 为上一任务 ID，追问“请给出最小修复方案”。
```

Bridge 会找到该任务对应的 SDK session/thread 并延续上下文。

### 检索研究

```text
调用 search_research，query 为“并发”，cwd 为当前项目。
```

## MCP 工具

| 工具 | 作用 |
|---|---|
| `delegate_to_claude` / `delegate_to_codex` | 创建异步只读调研任务 |
| `get_task_status` | 查询状态，不返回大结果 |
| `get_task_result` | 查询状态和最终答案 |
| `continue_peer_session` | 延续此前对侧会话 |
| `cancel_task` | 取消排队或运行任务 |
| `list_tasks` | 列出近期任务 |
| `search_research` | 检索已完成的调研 |

任务状态包括：`queued`、`running`、`completed`、`failed`、`cancelling`、`cancelled`、`timed_out`。

## 认证与计费

默认情况下 Bridge 会移除：

- Claude：`ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`
- Codex：`OPENAI_API_KEY`、`CODEX_API_KEY`

这样优先复用本机 CLI 保存的订阅/OAuth 登录，防止环境变量导致意外 API 费用。

如果组织禁用了订阅访问，可以在单次委派中设置 `auth_mode: "api"`。Bridge 会通过 MCP elicitation 请求客户端弹出确认；只有用户当次接受“可能产生 API 费用”后，才会把 API key 传给该任务。拒绝、超时或客户端不支持 elicitation 时都不会创建任务。每次续问也会重新确认。

## 数据与安全

- 数据库：`.agent-bridge/bridge.sqlite`，权限为 `0600`，目录不提交 Git。
- 子 agent：只读工具/沙箱，不能编辑文件或改变外部状态。
- 递归：子 agent 不加载项目 MCP；`AI_AGENT_BRIDGE_DEPTH` 再做深度保护。
- 超时：默认 300 秒，可配置 10–1800 秒。
- 结果：单条最多保存 100,000 字符。
- 同一 `session_key` 同时只允许一个活跃任务，避免会话历史分叉。
- API key：默认剥离；静态环境变量无法授权，必须通过当次 MCP 交互确认。

## 测试

```bash
# 单元与集成测试，不调用模型
npm test

# 两端真实 SDK 测试：首次任务 + 会话恢复
npm run test:e2e

# 只测试一端
AGENT_BRIDGE_E2E_AGENTS=codex npm run test:e2e
AGENT_BRIDGE_E2E_AGENTS=claude npm run test:e2e
```

真实测试会消耗对应模型额度。当前验证报告见 [docs/TEST_REPORT.md](docs/TEST_REPORT.md)。

## 架构

```text
Codex ── MCP ──┐
               ├── Agent Bridge server ── detached worker
Claude ── MCP ─┘            │                  ├── Codex SDK
                            │                  └── Claude Agent SDK
                            └── SQLite tasks + sessions + research
```

设计取舍见 [docs/RESEARCH.md](docs/RESEARCH.md)。
