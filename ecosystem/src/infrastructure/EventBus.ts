import { EventEmitter } from "events"
import { appendFile, readFile, mkdir } from "fs/promises"
import { dirname } from "path"
import { randomUUID } from "crypto"
import type { AgentEvent, AgentStatus, EventPriority } from "../core/types.js"

interface PendingReply {
  resolve: (event: AgentEvent) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class EcosystemEventBus extends EventEmitter {
  private history: AgentEvent[] = []
  private pendingReplies: Map<string, PendingReply> = new Map()
  private agentListeners: Map<string, Set<(event: AgentEvent) => void>> = new Map()

  constructor(private persistPath: string, private timeoutMs = 120_000) {
    super()
    this.setMaxListeners(100)
  }

  createEvent(
    from: string,
    to: string,
    type: AgentEvent["type"],
    content: string,
    status: AgentStatus = "info",
    priority: EventPriority = "normal",
    artifacts?: string[],
    replyTo?: string
  ): AgentEvent {
    return {
      id: randomUUID(),
      from,
      to,
      type,
      payload: { content, status, priority, artifacts },
      timestamp: Date.now(),
      replyTo,
    }
  }

  async emit_event(event: AgentEvent): Promise<void> {
    this.history.push(event)

    this.emit(`event:${event.to}`, event)
    this.emit("event:*", event)

    for (const handler of this.agentListeners.get(event.to) ?? []) {
      handler(event)
    }

    this.persist(event).catch(console.error)
  }

  async emitAndWait(event: AgentEvent): Promise<AgentEvent> {
    await this.emit_event(event)

    return new Promise<AgentEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingReplies.delete(event.id)
        resolve(this.createEvent(
          "system",
          event.from,
          "reply",
          "[系统] 等待回复超时，请继续工作。",
          "info",
          "normal",
          undefined,
          event.id
        ))
      }, this.timeoutMs)

      this.pendingReplies.set(event.id, { resolve, reject, timer })
    })
  }

  async reply(originalEventId: string, from: string, content: string, status: AgentStatus = "info"): Promise<void> {
    const pending = this.pendingReplies.get(originalEventId)
    const original = this.history.find(e => e.id === originalEventId)

    const replyEvent = this.createEvent(
      from,
      original?.from ?? "unknown",
      "reply",
      content,
      status,
      "normal",
      undefined,
      originalEventId
    )

    this.history.push(replyEvent)
    this.persist(replyEvent).catch(console.error)

    if (pending) {
      clearTimeout(pending.timer)
      this.pendingReplies.delete(originalEventId)
      pending.resolve(replyEvent)
    }
  }

  onAgent(agentId: string, handler: (event: AgentEvent) => void): () => void {
    if (!this.agentListeners.has(agentId)) {
      this.agentListeners.set(agentId, new Set())
    }
    this.agentListeners.get(agentId)!.add(handler)
    return () => { this.agentListeners.get(agentId)?.delete(handler) }
  }

  getPending(agentId: string): AgentEvent[] {
    return this.history.filter(
      e => e.to === agentId && e.type !== "reply"
    ).slice(-20)
  }

  getHistory(): AgentEvent[] {
    return [...this.history]
  }

  async recover(): Promise<void> {
    try {
      const data = await readFile(this.persistPath, "utf-8")
      const lines = data.split("\n").filter(Boolean)
      this.history = lines.map(l => JSON.parse(l) as AgentEvent)
    } catch {
      this.history = []
    }
  }

  private async persist(event: AgentEvent): Promise<void> {
    try {
      await mkdir(dirname(this.persistPath), { recursive: true })
      await appendFile(this.persistPath, JSON.stringify(event) + "\n")
    } catch (err) {
      console.error("[EventBus] persist failed:", err)
    }
  }
}
