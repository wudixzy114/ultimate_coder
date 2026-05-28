import type { OpencodeClient } from "@opencode-ai/sdk"
import type { AgentProfile } from "../core/types.js"
import type { EcosystemEventBus } from "./EventBus.js"
import type { Router } from "./Router.js"
import type { ToolRegistry } from "./ToolRegistry.js"

export class SessionManager {
  constructor(
    private client: OpencodeClient,
    private eventBus: EcosystemEventBus,
    private router: Router,
    private toolRegistry?: ToolRegistry
  ) {}

  async createSession(agent: AgentProfile): Promise<string> {
    const result = await this.client.session.create({
      body: { title: `${agent.id}-${Date.now()}` },
    })
    return result.data!.id
  }

  async injectContext(sessionId: string, agent: AgentProfile, task: string, extra?: string): Promise<void> {
    const pending = this.eventBus.getPending(agent.id)
    const pendingText = pending.length > 0
      ? "\n## 待处理消息\n" + pending.map(e =>
          `- [${e.type}] ${e.from}: ${e.payload.content}`
        ).join("\n")
      : ""

    const context = `
## 你的身份
角色: ${agent.name} (${agent.role})
团队: ${agent.team}
层级: Level ${agent.level}

## 当前任务
${task}

${extra ?? ""}
${pendingText}

## 通信工具
你只需要一个通信工具: tell_upper(content, status, artifacts?)
- content: 你要说的内容
- status: completed | blocked | need_decision | question
- artifacts: 相关文件路径列表(可选)

${this.toolRegistry?.promptFor("opencode") ?? ""}

## 原则
- 不需要知道上级是谁，调用 tell_upper 即可，系统自动路由
- 遇到不确定的事，tell_upper 问上级
- 任务完成后，tell_upper 汇报
- 系统已经帮你管理了git，你只需要在指定目录工作
`.trim()

    await this.client.session.prompt({
      path: { id: sessionId },
      body: {
        parts: [{ type: "text", text: context }],
        noReply: true,
      },
    })
  }

  async sendTask(sessionId: string, task: string): Promise<string> {
    const result = await this.client.session.prompt({
      path: { id: sessionId },
      body: {
        parts: [{ type: "text", text: task }],
      },
    })

    const message = result.data!
    const parts = (message as any).parts ?? []
    const textParts = parts.filter((p: any) => p.type === "text")
    return textParts.map((p: any) => p.text).join("\n")
  }

  async getMessages(sessionId: string) {
    const result = await this.client.session.messages({
      path: { id: sessionId },
    })
    return result.data ?? []
  }

  async getDiff(sessionId: string) {
    const result = await this.client.session.diff({
      path: { id: sessionId },
    })
    return result.data ?? []
  }

  async abortSession(sessionId: string) {
    await this.client.session.abort({ path: { id: sessionId } })
  }

  async waitForIdle(sessionId: string, pollMs = 2000): Promise<void> {
    return new Promise((resolve) => {
      const check = async () => {
        try {
          const events = await this.client.event.subscribe()
          for await (const event of events.stream!) {
            if (
              event.type === "session.idle" &&
              (event.properties as any)?.sessionId === sessionId
            ) {
              resolve()
              return
            }
          }
        } catch {
          setTimeout(check, pollMs)
        }
      }
      check()
    })
  }
}
