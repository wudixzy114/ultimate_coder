import type { ManagedToolDefinition } from "./ToolCore.js"
import { rustsearchTool } from "./rustsearchTool.js"

export const managedTools: Array<ManagedToolDefinition<any>> = [
  rustsearchTool,
]
