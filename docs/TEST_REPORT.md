# Agent Bridge 0.2 测试报告

测试日期：2026-07-03

测试平台：macOS，Node.js v26.0.0

Codex SDK：0.142.5

Claude Agent SDK：0.3.199

## 结论

核心实现通过全部自动化测试；Codex 的真实首次调用与同会话续问通过。Claude SDK 已验证到达官方认证服务，但测试环境的组织策略禁用了 Claude Code 订阅访问，同时现有 API key 余额不足，因此 Claude 模型调用属于外部认证阻塞，未宣称端到端通过。

## 自动化测试

命令：

```bash
npm test
```

覆盖范围：

- SQLite schema、任务创建与查询
- session ID 保存和恢复
- 研究结果搜索
- adapter 失败持久化
- Codex/Claude 调用方工具隔离
- MCP 初始化与异步工作流说明
- 排队任务取消
- 嵌套委派阻止
- 默认剥离 API key 与显式按量模式
- API 任务缺少当次确认时拒绝创建
- 订阅被组织策略禁止时进入 `awaiting_api_confirmation`
- 用户确认后以同一任务 ID 启动 API fallback

结果：19 项全部通过。最终交付前应以最新一次命令输出为准。

## Codex 真实端到端

命令：

```bash
AGENT_BRIDGE_E2E_AGENTS=codex npm run test:e2e
```

结果：通过。

| 检查项 | 结果 |
|---|---|
| 官方 Codex SDK 启动首次任务 | 通过 |
| 返回指定结果 | 通过 |
| 保存 thread ID | 通过 |
| 第二任务恢复同一 thread ID | 通过 |
| 首次耗时 | 20,204 ms |
| 续问耗时 | 26,178 ms |

验证 thread ID：`019f287e-b07f-78b2-904c-adcabb5ba402`。

追加执行完整 MCP → detached worker → Codex SDK 链路时，请求已经进入 Codex 服务，但账户随后达到用量上限，官方提示 2026-07-04 03:20 后重试。因此完整 MCP 链路的模型阶段未重复计为通过；此前 SDK 首次调用和会话恢复结果仍有效。无模型额度依赖的 detached worker 生命周期已由自动化集成测试覆盖。

## Claude 真实端到端

命令：

```bash
AGENT_BRIDGE_E2E_AGENTS=claude npm run test:e2e
```

结果：外部认证阻塞。

两种认证路径均被实际验证：

1. 继承当前 `ANTHROPIC_API_KEY`：官方返回 `Credit balance is too low`。
2. 默认订阅模式（Bridge 剥离 API key）：官方返回组织已禁用 Claude Code subscription access，要求使用 API key 或联系管理员开启。

这证明请求已进入 Claude Agent SDK/官方认证层，但当前账户状态无法完成模型响应。修复方式任选其一：

- 让组织管理员开启 Claude Code 订阅访问；或
- 为 API key 充值，并在 `retry_task_with_api` 的 MCP 确认提示中接受该次调用。

2026-07-05 已使用新版逐次确认流程重新验收：订阅调用首先进入 `awaiting_api_confirmation`，MCP elicitation 接受后以同一任务 ID 切换 API，随后 API 返回 `Credit balance is too low`。测试只执行一次且未自动重试。新版不再支持 `AGENT_BRIDGE_ALLOW_API_KEYS` 静态开关；充值后运行 `npm run test:claude-fallback`，并在确认提示中接受本次费用即可复验。

恢复认证后，重新运行 Claude 单端命令即可补齐验收。

## 安全测试结论

- Codex caller 不会获得 `delegate_to_codex`。
- Claude caller 不会获得 `delegate_to_claude`。
- 深度为 1 时拒绝再次委派。
- 默认不会把 API key 传给 SDK 子进程。
- Codex 真实任务使用 `read-only` sandbox 与 `approvalPolicy=never`。
- Claude 配置仅允许 Read/Glob/Grep/WebSearch/WebFetch，并启用 strict MCP config。

## 已知限制

- 异步 worker 是本机 detached 进程；机器重启会中断运行任务，但已完成结果与 session 映射仍保存在 SQLite。
- SQLite 搜索当前使用 `LIKE`，适合个人项目规模；大量历史记录可升级到 FTS5。
- Claude 完整端到端仍依赖账户管理员开启订阅访问；API fallback 还要求每次 MCP 交互确认及有效余额。
