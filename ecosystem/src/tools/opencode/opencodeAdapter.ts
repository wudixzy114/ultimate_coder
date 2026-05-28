import { tool } from "@opencode-ai/plugin"
import type { ManagedToolDefinition, ToolArgDefinition } from "../core/ToolCore.js"

export function createOpenCodeTool<TArgs extends object>(definition: ManagedToolDefinition<TArgs>) {
  return tool({
    description: definition.description,
    args: Object.fromEntries(
      (Object.entries(definition.args) as Array<[string, ToolArgDefinition]>)
        .map(([name, arg]) => [name, toOpenCodeSchema(arg)])
    ) as any,
    async execute(args, context) {
      return await definition.run(args as TArgs, {
        cwd: context.directory ?? process.cwd(),
        signal: context.abort,
      })
    },
  })
}

function toOpenCodeSchema(arg: ToolArgDefinition): any {
  let schema: any
  switch (arg.type) {
    case "string":
      schema = tool.schema.string()
      break
    case "number":
      schema = tool.schema.number()
      break
    case "boolean":
      schema = tool.schema.boolean()
      break
    case "enum":
      schema = tool.schema.enum(arg.values as [string, ...string[]])
      break
  }

  schema = schema.describe(arg.description)
  return arg.optional ? schema.optional() : schema
}
