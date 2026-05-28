# AI Agent Ecosystem - 自循环Agent生态系统

## 一、核心理念

### 三层模型
```
┌─────────────────────────────────────────────────┐
│  第一层: 环境与管理 (Environment)                 │
│  系统承担所有机械性工作:                          │
│    - Git worktree管理（创建/合并/回收）           │
│    - 消息路由（EventBus）                         │
│    - 阶段流转（Pipeline）                         │
│    - 状态持久化                                   │
│    - Dashboard展示                                │
│  Agent不需要操心这些事                            │
├─────────────────────────────────────────────────┤
│  第二层: 人 (Person/Agent)                        │
│  不干涉Agent的内部思维过程                        │
│  Agent = OpenCode Session + LLM + 工具链          │
│  只关心: 输入(任务) → 输出(结果)                  │
├─────────────────────────────────────────────────┤
│  第三层: 工具 (Tools)                             │
│  可插拔的工具集:                                  │
│    - OpenCode内置工具(read/write/bash/edit/...)   │
│    - MCP工具(sentry/github/context7/...)         │
│    - 自定义工具(tell_upper)                       │
│    - Skill(行为规范, 按需加载)                    │
└─────────────────────────────────────────────────┘
```

### 核心原则
1. **人不碰基础设施** — git管理、消息路由、状态管理由系统完成
2. **约束靠引导不靠限制** — 用Skill引导行为，不用Permission封禁工具
3. **每个人只对上级负责** — 不需要知道同级是谁，协调交给上级
4. **先多后少，先复杂后简单** — 探索所有可能性，再找最优解
5. **系统减负** — 能稳定实现的，不交给人去做

---

## 二、组织架构

### 三团队阶级模型

```
                         用户 (Human)
                            │
                     ┌──────▼──────┐
                     │ Orchestrator │  ← 系统编排层，唯一和用户交互的入口
                     │ (系统自动)   │
                     └──────┬──────┘
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
       ┌────────────┐ ┌────────────┐ ┌────────────┐
       │ 策划总经理  │ │ 总架构师    │ │ 总审核者    │  ← Level 1 领导
       │ (L1)       │ │ (L1)       │ │ (L1)       │
       └─────┬──────┘ └─────┬──────┘ └─────┬──────┘
             │              │              │
       ┌─────▼──────┐ ┌─────▼──────┐ ┌─────▼──────┐
       │ 策划者A     │ │ 开发者A     │ │ 审核员A     │  ← Level 2 成员
       │ 策划者B     │ │ 开发者B     │ │ 测试员A     │
       └────────────┘ │ 开发者C     │ └────────────┘
                      └────────────┘
```

### 交流规则
- **每个人只对上级负责** — 通过 `tell_upper` 工具
- **不需要和同级交流** — 需要协调时告诉上级
- **阶段之间由主管交接** — Orchestrator自动流转
- **领导分配任务给成员** — 系统注入到成员session

---

## 三、通信架构

### EventBus + 文件持久化

```
Agent ──tell_upper()──→ EventBus ──→ 上级Agent的Session
                              │
                              ├──→ Dashboard实时更新
                              └──→ events.jsonl持久化(fallback/审计)
```

### 唯一通信工具: tell_upper

```typescript
// Agent能做的唯一主动通信
tell_upper(content, status, artifacts?)

// 参数:
//   content: string     — 你要说的内容
//   status: completed | blocked | need_decision | question
//   artifacts?: string[] — 相关文件路径

// 行为:
//   系统自动查找这个agent的上级是谁
//   发送事件到EventBus
//   更新Dashboard
//   如果是blocked/need_decision，阻塞等待上级回复
```

### 路由表（系统维护，Agent不感知）

```typescript
const ROUTING_TABLE = {
  "planning-director": { team: "planning", level: 1, superior: "orchestrator" },
  "planner-a":         { team: "planning", level: 2, superior: "planning-director" },
  "planner-b":         { team: "planning", level: 2, superior: "planning-director" },
  "chief-architect":   { team: "development", level: 1, superior: "orchestrator" },
  "developer-a":       { team: "development", level: 2, superior: "chief-architect" },
  "developer-b":       { team: "development", level: 2, superior: "chief-architect" },
  "developer-c":       { team: "development", level: 2, superior: "chief-architect" },
  "chief-reviewer":    { team: "qa", level: 1, superior: "orchestrator" },
  "reviewer-a":        { team: "qa", level: 2, superior: "chief-reviewer" },
  "tester-a":          { team: "qa", level: 2, superior: "chief-reviewer" },
}
```

---

## 四、工作流（Pipeline）

### 阶段流转模型

```
Phase 1: 策划
  Orchestrator → inject → 策划总经理
    策划总经理 → inject → 策划者A/B
    策划者 → tell_upper → 策划总经理
  策划总经理 → tell_upper → Orchestrator (PRD完成)
  │
  ▼ 主管交接
Phase 2: 架构 + 开发
  Orchestrator → inject → 总架构师(PRD)
    总架构师拆解任务 → inject → 开发者A/B/C
    系统创建worktree
    开发者并行工作
    开发者 → tell_upper → 总架构师 (完成)
  总架构师合并代码 → tell_upper → Orchestrator
  │
  ▼ 主管交接
Phase 3: 审核 + 测试
  Orchestrator → inject → 总审核者(代码+diff)
    总审核者 → inject → 审核员A/测试员A
    审核/测试 → tell_upper → 总审核者
  总审核者汇总 → tell_upper → Orchestrator
  │
  ▼ 如有问题
Phase 4: 迭代修复
  Orchestrator → inject → 总架构师(review反馈)
    总架构师 → inject → 对应开发者(修复)
    开发者 → tell_upper → 总架构师
  总架构师 → tell_upper → Orchestrator
  │
  ▼ 回到Phase 3
  最多迭代N次，超过则升级给用户
```

### 状态机

```
INIT → PLANNING → DEVELOPING → REVIEWING
                                  │
                    ┌─────────────┼─────────────┐
                    ▼             ▼              ▼
                 DONE      ITERATING → REVIEWING (循环)
                                │
                                ▼ (超过max_iterations)
                            ESCALATED → 交给用户决策
```

---

## 五、项目结构

```
ultimate_coder/
├── PLAN.md                          # 本文档
├── opencode.json                    # OpenCode配置
│
├── .opencode/
│   ├── skills/                      # 7个角色的行为规范
│   │   ├── planning-director/SKILL.md
│   │   ├── planner/SKILL.md
│   │   ├── chief-architect/SKILL.md
│   │   ├── developer/SKILL.md
│   │   ├── chief-reviewer/SKILL.md
│   │   ├── reviewer/SKILL.md
│   │   └── tester/SKILL.md
│   └── tools/
│       └── tell_upper.ts            # 唯一的通信工具
│
├── ecosystem/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts                 # 入口
│       ├── core/
│       │   └── types.ts             # 类型定义
│       ├── infrastructure/
│       │   ├── OpenCodeBridge.ts    # SDK桥接(server启停/health check)
│       │   ├── SessionManager.ts    # Session生命周期
│       │   ├── WorkspaceManager.ts  # Worktree管理
│       │   ├── EventBus.ts          # 事件总线
│       │   ├── Router.ts            # 路由表
│       │   └── Dashboard.ts         # 状态展示
│       └── workflow/
│           ├── Orchestrator.ts      # 主编排(Pipeline)
│           └── PhaseRunner.ts       # 单阶段执行器
│
└── .ecosystem/                      # 运行时状态(git管理)
    ├── state.json                   # 工作流状态
    ├── events.jsonl                 # 事件日志
    └── dashboard.json               # Dashboard数据
```

---

## 六、关键数据结构

```typescript
// === 核心类型 ===

interface AgentProfile {
  id: string
  name: string
  role: string
  team: "planning" | "development" | "qa"
  level: 0 | 1 | 2
  superior?: string
}

interface AgentEvent {
  id: string
  from: string               // 系统自动填充
  to: string                 // 系统根据路由表计算
  type: "tell_upper" | "task_assigned" | "system"
  payload: {
    content: string
    status: "completed" | "blocked" | "need_decision" | "question" | "info"
    artifacts?: string[]
    priority: "low" | "normal" | "high" | "urgent"
  }
  timestamp: number
  replyTo?: string           // 回复的原事件ID
}

interface WorkflowState {
  phase: "init" | "planning" | "developing" | "reviewing" | "iterating" | "done" | "escalated"
  requirement: string
  iteration: number
  maxIterations: number
  phases: Record<string, PhaseResult>
  startedAt: number
  updatedAt: number
}

interface PhaseResult {
  status: "pending" | "running" | "completed" | "blocked"
  leader: string
  workers: Record<string, WorkerResult>
  output?: string
  artifacts: string[]
}

interface WorkerResult {
  agentId: string
  status: "idle" | "working" | "completed" | "blocked"
  sessionId?: string
  workspace?: string
  output?: string
}

interface DashboardState {
  requirement: string
  currentPhase: string
  iteration: number
  elapsed: string
  agents: Record<string, { status: string; message: string; time: number }>
  artifacts: Record<string, string>
  timeline: Array<{ time: number; event: string }>
}
```

---

## 七、实施步骤

### 阶段一：基础设施
| 步骤 | 内容 | 文件 | 工作量 |
|------|------|------|--------|
| 1 | 项目初始化(npm init + 依赖) | package.json, tsconfig.json | 0.5h |
| 2 | 核心类型定义 | src/core/types.ts | 0.5h |
| 3 | EventBus实现 | src/infrastructure/EventBus.ts | 1.5h |
| 4 | Router实现 | src/infrastructure/Router.ts | 0.5h |

### 阶段二：Agent层
| 步骤 | 内容 | 文件 | 工作量 |
|------|------|------|--------|
| 5 | tell_upper工具 | .opencode/tools/tell_upper.ts | 1h |
| 6 | 7个SKILL.md | .opencode/skills/*/SKILL.md | 1.5h |
| 7 | OpenCode配置 | opencode.json | 0.5h |

### 阶段三：核心逻辑
| 步骤 | 内容 | 文件 | 工作量 |
|------|------|------|--------|
| 8 | OpenCodeBridge | src/infrastructure/OpenCodeBridge.ts | 1.5h |
| 9 | SessionManager | src/infrastructure/SessionManager.ts | 2h |
| 10 | WorkspaceManager | src/infrastructure/WorkspaceManager.ts | 1.5h |
| 11 | Dashboard | src/infrastructure/Dashboard.ts | 1h |

### 阶段四：工作流
| 步骤 | 内容 | 文件 | 工作量 |
|------|------|------|--------|
| 12 | PhaseRunner | src/workflow/PhaseRunner.ts | 1.5h |
| 13 | Orchestrator | src/workflow/Orchestrator.ts | 2h |

### 阶段五：验证
| 步骤 | 内容 | 文件 | 工作量 |
|------|------|------|--------|
| 14 | 端到端测试 | src/index.ts | 2h |
| **合计** | | | **~17h** |

---

## 八、Dashboard示例

```
┌──────────────────────────────────────────────────────────────┐
│                    Ecosystem Dashboard                        │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  需求: 添加用户登录功能                                       │
│  阶段: Phase 3 - 审核中                                      │
│  迭代: 第 1/5 次                                             │
│  耗时: 12 分钟                                               │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│  Phase 1: 策划 ✓                                            │
│    ├─ 策划总经理: 已分配任务                                  │
│    ├─ 策划者A: PRD完成                                       │
│    └─ 策划者B: 用户故事完成                                   │
│    产出: [prd.md] [user-stories.md]                          │
│                                                              │
│  Phase 2: 开发 ✓                                            │
│    ├─ 总架构师: 拆解为3个任务                                 │
│    ├─ 开发者A: 邮箱登录完成 (branch: feat/auth-email)        │
│    ├─ 开发者B: 手机登录完成 (branch: feat/auth-phone)        │
│    └─ 开发者C: 密码加密完成 (branch: feat/auth-crypto)       │
│    产出: [diff] [merged to main]                             │
│                                                              │
│  Phase 3: 审核中...                                          │
│    ├─ 总审核者: 已分配审查                                    │
│    ├─ 审核员A: 发现问题 → 密码未hash                         │
│    └─ 测试员A: 编写测试中...                                 │
│    产出: [review-001.md] (blocked)                           │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│  事件流 (最近):                                              │
│    14:32 审核员A → 总审核者: "密码未hash, 需修复"             │
│    14:30 测试员A → 总审核者: "集成测试编写中"                 │
│    14:28 总审核者 → Orchestrator: "审查已开始"                │
│    14:25 总架构师 → Orchestrator: "代码已合并"                │
└──────────────────────────────────────────────────────────────┘
```

---

## 九、技术选型确认

| 维度 | 选择 | 理由 |
|------|------|------|
| 语言 | TypeScript/Node.js | 与OpenCode SDK同生态 |
| 运行模式 | Headless Server + SDK | 完全自动化 |
| 通信 | 进程内EventEmitter + 文件持久化 | 单机简单高效 |
| 回复机制 | 同步等待(Promise + 超时) | agent问完等答案再继续 |
| Skill | 运行时按需加载 | agent调用skill工具加载 |
| 约束 | Skill引导 + prompt约束 | 不限制工具能力 |
| Git | 系统自动worktree | 降低agent认知负担 |
| 状态 | JSON文件 | 简单可靠，支持断点恢复 |
