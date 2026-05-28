import type { ManagedToolDefinition, ToolExecutionContext } from "../core/ToolCore.js"

type ReportStatus = "completed" | "blocked" | "need_decision" | "question"
type ReportPriority = "normal" | "high"

interface TellUpperArgs {
  content: string
  status: ReportStatus
  artifacts?: string[] | string
}

interface ReportEvent {
  id: string
  from: string
  to: string
  type: "tell_upper"
  payload: {
    content: string
    status: ReportStatus
    priority: ReportPriority
    artifacts?: string[]
  }
  timestamp: number
}

interface TellUpperContext extends ToolExecutionContext {
  agent?: string
  eventBus?: {
    emit_event(event: ReportEvent): Promise<void>
  }
  router?: {
    getSuperior(agentId: string): string | undefined
  }
}

export const tellUpperTool: ManagedToolDefinition<TellUpperArgs> = {
  name: "tell_upper",
  description: "Report progress, blockers, decisions, or questions to the current agent's superior.",
  promptHint: "Internal communication tool. Use it when work is completed, blocked, needs a decision, or needs a superior answer; routing is handled by the system.",
  audiences: ["opencode", "codex", "system"],
  category: "internal",
  command: "tell_upper({ content, status, artifacts? })",
  args: {
    content: { type: "string", description: "The message to send." },
    status: {
      type: "enum",
      values: ["completed", "blocked", "need_decision", "question"],
      description: "Current status: completed, blocked, need_decision, or question.",
    },
    artifacts: { type: "string", description: "Optional comma-separated related file paths.", optional: true },
  },
  async run(args, context) {
    return await runTellUpper(args, context as TellUpperContext)
  },
}

export async function runTellUpper(args: TellUpperArgs, context: TellUpperContext): Promise<string> {
  const agentId = context.agent ?? "unknown"
  const artifacts = Array.isArray(args.artifacts)
    ? args.artifacts
    : typeof args.artifacts === "string"
      ? args.artifacts.split(",").map(item => item.trim()).filter(Boolean)
      : undefined

  const event: ReportEvent = {
    id: crypto.randomUUID(),
    from: agentId,
    to: "superior",
    type: "tell_upper",
    payload: {
      content: args.content,
      status: args.status,
      priority: args.status === "blocked" || args.status === "need_decision" ? "high" : "normal",
      artifacts,
    },
    timestamp: Date.now(),
  }

  const superior = context.router?.getSuperior(agentId)
  if (context.eventBus && superior) {
    event.to = superior
    await context.eventBus.emit_event(event)
  }

  if (args.status === "blocked" || args.status === "need_decision") {
    return `Message sent to superior; waiting for reply. eventId=${event.id}`
  }

  return `Reported to superior. status=${args.status}`
}
