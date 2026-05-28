import type { ToolAudience, ToolCategory } from "../../core/types.js"

export type ToolArgDefinition =
  | { type: "string"; description: string; optional?: boolean }
  | { type: "number"; description: string; optional?: boolean }
  | { type: "boolean"; description: string; optional?: boolean }
  | { type: "enum"; description: string; values: readonly string[]; optional?: boolean }

export interface ToolExecutionContext {
  cwd: string
  signal?: AbortSignal
  agent?: string
  eventBus?: unknown
  router?: unknown
}

export interface ManagedToolDefinition<TArgs extends object = object> {
  name: string
  description: string
  promptHint: string
  audiences: ToolAudience[]
  category: ToolCategory
  command: string
  args: Record<keyof TArgs & string, ToolArgDefinition>
  run(args: TArgs, context: ToolExecutionContext): Promise<string>
}
