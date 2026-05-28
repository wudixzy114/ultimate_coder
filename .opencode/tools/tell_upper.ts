import { tool } from "@opencode-ai/plugin"

export default tool({
  description: "向你的上级汇报或提问。完成任务、遇到问题、需要决策时使用。这是你唯一的通信方式。",
  args: {
    content: tool.schema.string().describe("你要传达的内容"),
    status: tool.schema
      .enum(["completed", "blocked", "need_decision", "question"])
      .describe("当前状态: completed=任务完成, blocked=被阻塞, need_decision=需要上级决策, question=有疑问"),
    artifacts: tool.schema
      .array(tool.schema.string())
      .describe("相关文件路径列表(可选)")
      .optional(),
  },
  async execute(args, context) {
    const agentId = (context as any).agent ?? "unknown"

    const event = {
      id: crypto.randomUUID(),
      from: agentId,
      to: "superior", // 系统自动解析
      type: "tell_upper" as const,
      payload: {
        content: args.content,
        status: args.status as any,
        priority: args.status === "blocked" || args.status === "need_decision" ? "high" as const : "normal" as const,
        artifacts: args.artifacts,
      },
      timestamp: Date.now(),
    }

    // 通过全局EventBus发送（由SessionManager注入到context）
    const eventBus = (context as any).eventBus
    if (eventBus) {
      const superior = (context as any).router?.getSuperior(agentId)
      if (superior) {
        event.to = superior
        await eventBus.emit_event(event)
      }
    }

    if (args.status === "blocked" || args.status === "need_decision") {
      return `消息已发送给上级，等待回复中... (事件ID: ${event.id})`
    }

    return `已汇报给上级。(${args.status})`
  },
})
