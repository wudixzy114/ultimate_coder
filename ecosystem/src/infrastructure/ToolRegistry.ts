import { mkdir, writeFile } from "fs/promises"
import { dirname } from "path"
import type { ToolAudience, ToolDefinition, ToolRegistryState } from "../core/types.js"
import { managedTools } from "../tools/index.js"

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>()

  constructor(private persistPath?: string) {}

  register(tool: ToolDefinition): void {
    if (!tool.name.trim()) throw new Error("Tool name is required")
    if (!tool.description.trim()) throw new Error(`Tool ${tool.name} description is required`)
    if (!tool.promptHint.trim()) throw new Error(`Tool ${tool.name} promptHint is required`)
    this.tools.set(tool.name, tool)
  }

  registerAll(tools: ToolDefinition[]): void {
    for (const tool of tools) this.register(tool)
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  list(audience?: ToolAudience): ToolDefinition[] {
    const tools = [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name))
    if (!audience) return tools
    return tools.filter(tool => tool.audiences.includes(audience))
  }

  promptFor(audience: ToolAudience): string {
    const tools = this.list(audience)
    if (tools.length === 0) return ""

    return [
      "## Available Managed Tools",
      ...tools.map(tool => {
        const command = tool.command ? `\n  Usage: ${tool.command}` : ""
        return `- ${tool.name} [${tool.category}]: ${tool.promptHint}${command}`
      }),
    ].join("\n")
  }

  toJSON(): ToolRegistryState {
    return {
      tools: this.list(),
      updatedAt: Date.now(),
    }
  }

  async persist(): Promise<void> {
    if (!this.persistPath) return
    await mkdir(dirname(this.persistPath), { recursive: true })
    await writeFile(this.persistPath, JSON.stringify(this.toJSON(), null, 2))
  }
}

export function createDefaultToolRegistry(persistPath?: string): ToolRegistry {
  const registry = new ToolRegistry(persistPath)

  registry.registerAll(
    managedTools.map(tool => ({
      name: tool.name,
      description: tool.description,
      audiences: tool.audiences,
      category: tool.category,
      command: tool.command,
      promptHint: tool.promptHint,
    }))
  )

  return registry
}
