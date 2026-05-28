import type { ManagedToolDefinition } from "./ToolCore.js"
import { rustlocaldocTool } from "./rustlocaldocTool.js"
import { rustsearchTool } from "./rustsearchTool.js"

export const managedTools: Array<ManagedToolDefinition<any>> = [
  rustlocaldocTool,
  rustsearchTool,
]
