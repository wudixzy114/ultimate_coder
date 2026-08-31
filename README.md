# ultimate_coder

> **自循环 AI Agent 生态：把一个需求丢进去，策划→架构→开发→审核→迭代全部自动化跑完。**

## 项目定位 / 背景

`ultimate_coder` 是一套"零监督软件研发"的多 Agent 协作框架。它要解决的核心问题是：**单个 AI Agent 既要懂产品又要写代码还要自测，质量不可控、上下文溢出、单点失败无人接管**。于是按"真实软件公司"的角色模型，把工作切成 **3 个团队、7 个角色、3 个阶段** 的流水线：

- **策划团队**（`planning-director` + `planner-a/b`）做需求拆解、PRD 编写、用户故事
- **开发团队**（`chief-architect` + `developer-a/b/c`）做技术架构、并行编码、git worktree 隔离
- **审核团队**（`chief-reviewer` + `reviewer-a` + `tester-a`）做代码审查 + 自动化测试 + 迭代返工

底层挂接的是 **OpenCode SDK**（`@opencode-ai/sdk` + `@opencode-ai/plugin`），所有 subagent 都跑在 `anthropic/claude-sonnet-4-20250514` 上（温度按角色分工：策划 0.2/0.3、开发 0.3、审核 0.1、测试 0.2）。Agent 之间不直接通信——它们只能调用 `tell_upper` 一个工具向"上级"汇报，路由由系统 `Router` 维护，事件通过 `EcosystemEventBus` 异步派发、落到 `events.jsonl` 持久化文件。

整条管线是"系统做机械活、Agent 只做创造性活"的分工：系统负责开 git worktree、合并代码、阶段流转、状态持久化、Dashboard 渲染；Agent 只负责读需求、产出文档、写代码。失败按 `Escalated → 交给用户` 兜底，超过 `maxIterations`（默认 3）自动升级。

## 仓库结构

```
ultimate_coder/
├── PLAN.md                          # 完整设计文档（三层模型/组织/通信/工作流/数据结构）
├── opencode.json                    # OpenCode 7 个 subagent 配置
├── .opencode/
│   └── skills/                      # 7 个角色行为规范（SKILL.md）
├── ecosystem/                       # 核心运行时（TypeScript / Node 20+）
│   ├── package.json                 # @opencode-ai/sdk + zod + tsx
│   ├── scripts/deploy-opencode-tools.ts   # 把工具部署到 local/global
│   ├── src/
│   │   ├── index.ts                 # 入口: `tsx src/index.ts "你的需求"`
│   │   ├── core/types.ts            # AgentEvent / WorkflowState / ToolDefinition
│   │   ├── infrastructure/
│   │   │   ├── OpenCodeBridge.ts    # SDK 桥接（启停 server / health check）
│   │   │   ├── SessionManager.ts    # Session 生命周期 + 上下文注入
│   │   │   ├── WorkspaceManager.ts  # Git worktree 管理
│   │   │   ├── EventBus.ts          # 事件总线 + JSONL 持久化
│   │   │   ├── Router.ts            # 上下级路由表
│   │   │   ├── ToolRegistry.ts      # 工具注册表（OpenCode/Codex/System）
│   │   │   └── Dashboard.ts         # 实时状态面板
│   │   ├── workflow/
│   │   │   ├── Orchestrator.ts      # 主状态机: init→planning→developing→reviewing→iterating
│   │   │   └── PhaseRunner.ts       # 单阶段执行器
│   │   └── tools/
│   │       ├── core/ToolCore.ts     # 工具定义抽象
│   │       ├── internal/tellUpperTool.ts  # 唯一通信工具
│   │       ├── opencode/opencodeAdapter.ts # OpenCode plugin 适配
│   │       └── rust/
│   │           ├── searchTool.ts    # Rust 文档查询（action: search/crate/item/std/migrations/url/sources）
│   │           └── localDocTool.ts  # 本地 Rust 项目文档
│   └── test/tools/rust/             # vitest/node test 占位
└── .ecosystem/                      # 运行时状态（git 忽略）
    ├── state.json                   # 工作流状态
    ├── events.jsonl                 # 事件审计日志
    └── dashboard.json               # Dashboard 快照
```

## 技术栈

| 维度 | 选型 | 版本/说明 |
|------|------|-----------|
| 运行时 | Node.js | >= 20 |
| 语言 | TypeScript | ^5.5.0（ESM、NodeNext） |
| 执行器 | tsx | ^4.16.0（无需 build） |
| Agent 框架 | OpenCode SDK | @opencode-ai/sdk latest, @opencode-ai/plugin ^1.15.11 |
| 模型 | Claude Sonnet 4 | anthropic/claude-sonnet-4-20250514 |
| 校验 | zod | ^3.23.0 |
| 状态持久化 | JSON 文件 | state.json / events.jsonl / dashboard.json |
| 测试 | node --test | `tsx --test test/**/*.test.ts` |

## 核心模块 / 特性

### 1. `Orchestrator` —— 主状态机
`src/workflow/Orchestrator.ts` 实现完整状态机。`run(requirement)` 串起三阶段：

```
planning (策划) → developing (架构+开发) → reviewing (审核)
                                              ↓
                                          iterating (修复循环, 默认 3 次)
                                              ↓
                                          done | escalated
```

每个阶段通过 `PhaseRunner.run({ leader, workers, task })` 派发给对应 subagent，等待 `tell_upper` 事件后再流转。任何阶段 `status === "blocked"` 立即终止为 `escalated`，并把详细原因写进 Dashboard。

### 2. `EventBus` + `Router` —— 唯一通信机制
所有 Agent 只能调用 `tell_upper(content, status, artifacts?)`。`Router` 维护 `ROUTING_TABLE`（如 `developer-a → chief-architect → orchestrator`），事件经 `EcosystemEventBus` 派发，同步写到 `events.jsonl` 供断点恢复。同步等待用 `emitAndWait` + Promise + 120s 超时，失败自动回复 `[系统] 等待回复超时`。

### 3. `SessionManager` —— Agent 上下文注入
`injectContext` 给每个 session 注入身份卡（角色、团队、层级）、任务描述、待处理消息、可用工具清单、原则提示，**Agent 不需要知道上级是谁**——由系统按 `skillName` 路由。

### 4. `WorkspaceManager` —— Git Worktree 自动化
开发者并行编码时自动开 worktree、分配分支（`feat/auth-email` 等）、完成时合并到 main、回收集群——开发者完全不用碰 git。

### 5. `ToolRegistry` —— 跨平台工具抽象
工具定义 `ToolDefinition` 包含 `audiences: ["opencode" | "codex" | "system"]` 和 `category: "internal" | "extension"`，新增工具只改注册表不改 Agent 组织模型。`deploy-opencode-tools.ts` 一键部署到 local/global。

### 6. Rust 文档工具链（已落地）
`tools/rust/` 下的 `searchTool` 提供 7 个 action（`search`/`crate`/`item`/`std`/`migrations`/`url`/`sources`），自动从 doc.rust-lang.org / docs.rs / crates.io 抓取并清洗页面，本地 `.rustdoc-cache/` 缓存 14 天。

## 已完成 / 进行中

- ✅ PLAN.md 完整设计文档（核心模型 + 状态机 + 数据结构 + 实施步骤）
- ✅ `opencode.json` 7 个 subagent 配置
- ✅ `.opencode/skills/` 7 份 SKILL.md（chief-architect / developer / chief-reviewer / reviewer / tester / planning-director / planner）
- ✅ `ecosystem/` TypeScript 运行时（core / infrastructure / workflow / tools 四层全部代码到位）
- ✅ `EventBus` / `Router` / `SessionManager` / `WorkspaceManager` / `Dashboard` / `ToolRegistry` 实现完整
- ✅ `Orchestrator.run` 主状态机 + PhaseRunner 单阶段执行
- ✅ `tell_upper` 通信工具 + OpenCode plugin 适配器
- ✅ Rust 文档查询工具（`searchTool` / `localDocTool`）
- ⏳ 端到端真实跑通（PLAN 估算 ~17h 工程量，目前停留在 1 commit 的初始 commit）
- ⏳ `ecosystem/test/` 仅放了 `localDocTool.test.ts` 一个单测样例，其余模块无测试覆盖
- ⏳ 真实的 OpenCode server 接入未在生产中验证

## 本地开发

```bash
# 环境要求：Node >= 20
cd ultimate_coder/ecosystem
npm install

# 类型检查
npm run typecheck

# 启动（依赖 OpenCode server 与 Anthropic API key）
export ANTHROPIC_API_KEY=...
npx tsx src/index.ts "你的需求描述"

# 部署工具到 OpenCode
npm run tools:deploy:local
npm run tools:deploy:global

# 测试
npm test
```

`.ecosystem/state.json` 是工作流恢复锚点——删除它从 `init` 重跑，保留它从上次阶段续跑。

## 状态

**v0.1.0（初始 commit）** —— 设计已就位、核心代码已写完、端到端实测待补。适合作为框架蓝本二次开发，不建议直接投产。

## License

MIT
