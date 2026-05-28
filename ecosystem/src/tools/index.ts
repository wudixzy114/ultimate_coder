import type { ManagedToolDefinition } from "./core/ToolCore.js"
import { tellUpperTool } from "./internal/tellUpperTool.js"
import { rustlocaldocTool } from "./rust/localDocTool.js"
import { rustsearchTool } from "./rust/searchTool.js"

export const managedTools: Array<ManagedToolDefinition<any>> = [
  tellUpperTool,
  rustlocaldocTool,
  rustsearchTool,
]
