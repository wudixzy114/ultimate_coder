// ============================================================
// AgentEvent — 生态系统中所有事件的统一类型
// ============================================================

export interface AgentEvent {
  id: string
  from: string
  to: string
  type: "tell_upper" | "task_assigned" | "system" | "reply"
  payload: {
    content: string
    status: AgentStatus
    artifacts?: string[]
    priority: EventPriority
    context?: Record<string, unknown>
  }
  timestamp: number
  replyTo?: string
}

export type AgentStatus = "completed" | "blocked" | "need_decision" | "question" | "info" | "working"
export type EventPriority = "low" | "normal" | "high" | "urgent"

// ============================================================
// AgentProfile — Agent身份信息
// ============================================================

export interface AgentProfile {
  id: string
  name: string
  role: string
  team: TeamName
  level: 0 | 1 | 2
  superior?: string
  skillName: string
}

export type TeamName = "planning" | "development" | "qa"

// ============================================================
// WorkflowState — 工作流全局状态
// ============================================================

export interface WorkflowState {
  phase: WorkflowPhase
  requirement: string
  iteration: number
  maxIterations: number
  phases: Record<string, PhaseResult>
  startedAt: number
  updatedAt: number
}

export type WorkflowPhase =
  | "init"
  | "planning"
  | "developing"
  | "reviewing"
  | "iterating"
  | "done"
  | "escalated"

export interface PhaseResult {
  status: "pending" | "running" | "completed" | "blocked"
  leader: string
  workers: Record<string, WorkerResult>
  output?: string
  artifacts: string[]
  startedAt?: number
  completedAt?: number
}

export interface WorkerResult {
  agentId: string
  status: "idle" | "working" | "completed" | "blocked"
  sessionId?: string
  workspace?: string
  output?: string
  error?: string
}

// ============================================================
// Tool extensibility
// ============================================================

export type ToolAudience = "opencode" | "codex" | "system"

export interface ToolDefinition {
  name: string
  description: string
  audiences: ToolAudience[]
  command?: string
  promptHint: string
}

export interface ToolRegistryState {
  tools: ToolDefinition[]
  updatedAt: number
}

// ============================================================
// Dashboard
// ============================================================

export interface DashboardState {
  requirement: string
  currentPhase: string
  iteration: number
  elapsed: string
  agents: Record<string, AgentDashboardInfo>
  artifacts: Record<string, string>
  timeline: TimelineEntry[]
}

export interface AgentDashboardInfo {
  status: string
  message: string
  time: number
}

export interface TimelineEntry {
  time: number
  agent: string
  event: string
}

// ============================================================
// Phase配置
// ============================================================

export interface PhaseConfig {
  name: string
  leader: string
  workers: string[]
  task: string | PhaseResult
  injectContext?: Record<string, unknown>
}
