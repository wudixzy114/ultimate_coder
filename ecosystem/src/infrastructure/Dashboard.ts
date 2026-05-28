import { writeFile, readFile, mkdir } from "fs/promises"
import { dirname } from "path"
import type { DashboardState, AgentDashboardInfo, TimelineEntry } from "../core/types.js"

export class Dashboard {
  private state: DashboardState
  private renderTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private persistPath: string, requirement: string) {
    this.state = {
      requirement,
      currentPhase: "init",
      iteration: 0,
      elapsed: "0s",
      agents: {},
      artifacts: {},
      timeline: [],
    }
  }

  updatePhase(phase: string, iteration?: number): void {
    this.state.currentPhase = phase
    if (iteration !== undefined) this.state.iteration = iteration
    this.addTimeline("system", `进入阶段: ${phase}`)
    this.scheduleRender()
  }

  updateAgent(agentId: string, status: string, message?: string): void {
    this.state.agents[agentId] = {
      status,
      message: message ?? status,
      time: Date.now(),
    }
    this.addTimeline(agentId, message ?? status)
    this.scheduleRender()
  }

  updateArtifact(name: string, path: string): void {
    this.state.artifacts[name] = path
    this.addTimeline("system", `产出物: ${name} → ${path}`)
    this.scheduleRender()
  }

  updateElapsed(startTime: number): void {
    const ms = Date.now() - startTime
    const s = Math.floor(ms / 1000)
    const m = Math.floor(s / 60)
    const h = Math.floor(m / 60)
    this.state.elapsed = h > 0 ? `${h}h${m % 60}m` : m > 0 ? `${m}m${s % 60}s` : `${s}s`
  }

  private addTimeline(agent: string, event: string): void {
    this.state.timeline.push({ time: Date.now(), agent, event })
    if (this.state.timeline.length > 100) {
      this.state.timeline = this.state.timeline.slice(-50)
    }
  }

  private scheduleRender(): void {
    if (this.renderTimer) return
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null
      this.render()
    }, 1000)
  }

  render(): void {
    const s = this.state
    const phaseIcon = (status: string) => {
      switch (status) {
        case "completed": return "✓"
        case "working": case "running": return "..."
        case "blocked": return "✗"
        default: return "○"
      }
    }

    const lines = [
      "┌──────────────────────────────────────────────────────────────┐",
      "│                    Ecosystem Dashboard                        │",
      "├──────────────────────────────────────────────────────────────┤",
      `│  需求: ${s.requirement.slice(0, 50).padEnd(52)}│`,
      `│  阶段: ${s.currentPhase.padEnd(52)}│`,
      `│  迭代: ${String(s.iteration).padEnd(52)}│`,
      `│  耗时: ${s.elapsed.padEnd(52)}│`,
      "├──────────────────────────────────────────────────────────────┤",
    ]

    const agentsByPhase: Record<string, string[]> = {}
    for (const [id, info] of Object.entries(s.agents)) {
      const icon = phaseIcon(info.status)
      const line = `    ${icon} ${id}: ${info.message}`
      if (!agentsByPhase["agents"]) agentsByPhase["agents"] = []
      agentsByPhase["agents"].push(line)
    }

    for (const [, agentLines] of Object.entries(agentsByPhase)) {
      lines.push(...agentLines)
    }

    if (Object.keys(s.artifacts).length > 0) {
      lines.push("├──────────────────────────────────────────────────────────────┤")
      lines.push("│  产出物:                                                      │")
      for (const [name, path] of Object.entries(s.artifacts)) {
        lines.push(`│    ${name}: ${path.slice(0, 45).padEnd(45)}│`)
      }
    }

    const recentTimeline = s.timeline.slice(-8)
    if (recentTimeline.length > 0) {
      lines.push("├──────────────────────────────────────────────────────────────┤")
      lines.push("│  事件流:                                                      │")
      for (const entry of recentTimeline) {
        const time = new Date(entry.time).toLocaleTimeString("zh-CN", { hour12: false })
        lines.push(`│    ${time} ${entry.agent}: ${entry.event.slice(0, 40).padEnd(40)}│`)
      }
    }

    lines.push("└──────────────────────────────────────────────────────────────┘")

    console.clear()
    console.log(lines.join("\n"))
    this.persist().catch(console.error)
  }

  async persist(): Promise<void> {
    try {
      await mkdir(dirname(this.persistPath), { recursive: true })
      await writeFile(this.persistPath, JSON.stringify(this.state, null, 2))
    } catch (err) {
      console.error("[Dashboard] persist failed:", err)
    }
  }

  async recover(): Promise<void> {
    try {
      const data = await readFile(this.persistPath, "utf-8")
      this.state = JSON.parse(data)
    } catch {
      // fresh state
    }
  }

  getState(): DashboardState {
    return { ...this.state }
  }
}
