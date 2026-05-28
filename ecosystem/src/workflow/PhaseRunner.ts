import type { AgentProfile, PhaseConfig, PhaseResult, WorkflowState } from "../core/types.js"
import type { SessionManager } from "../infrastructure/SessionManager.js"
import type { EcosystemEventBus } from "../infrastructure/EventBus.js"
import type { Router } from "../infrastructure/Router.js"
import type { Dashboard } from "../infrastructure/Dashboard.js"

export class PhaseRunner {
  constructor(
    private sessionManager: SessionManager,
    private eventBus: EcosystemEventBus,
    private router: Router,
    private dashboard: Dashboard
  ) {}

  async run(config: PhaseConfig): Promise<PhaseResult> {
    console.log(`\n[PhaseRunner] Starting phase: ${config.name}`)
    this.dashboard.updatePhase(config.name)

    const leaderProfile = this.router.getAgent(config.leader)!
    this.dashboard.updateAgent(config.leader, "working", "接收任务")

    const leaderSession = await this.sessionManager.createSession(leaderProfile)

    const taskContent = typeof config.task === "string"
      ? config.task
      : JSON.stringify(config.task, null, 2)

    await this.sessionManager.injectContext(
      leaderSession,
      leaderProfile,
      `你负责的阶段: ${config.name}\n\n${taskContent}`,
      config.injectContext
        ? `\n## 附加信息\n${JSON.stringify(config.injectContext, null, 2)}`
        : undefined
    )

    this.dashboard.updateAgent(config.leader, "working", "分析任务，准备分配")

    const workerTaskPromises: Promise<void>[] = []

    const leaderResult = await this.sessionManager.sendTask(
      leaderSession,
      `请分析任务并分配给你的团队成员。你有以下成员: ${config.workers.join(", ")}。\n` +
      `对于每个成员，请使用 tell_upper 工具说明分配给他们的具体任务。\n` +
      `完成后，使用 tell_upper 汇报整体分配方案。`
    )

    console.log(`[PhaseRunner] Leader ${config.leader} result:`, leaderResult.slice(0, 200))

    for (const workerId of config.workers) {
      const workerProfile = this.router.getAgent(workerId)!
      this.dashboard.updateAgent(workerId, "working", "执行任务")

      const promise = (async () => {
        try {
          const workerSession = await this.sessionManager.createSession(workerProfile)

          await this.sessionManager.injectContext(
            workerSession,
            workerProfile,
            `阶段: ${config.name}\n你的上级已分配任务给你。请根据上下文中的信息执行任务。\n完成后使用 tell_upper 汇报结果。`
          )

          const workerResult = await this.sessionManager.sendTask(
            workerSession,
            `请执行你的任务。完成后使用 tell_upper(content, status="completed", artifacts=[产出物路径]) 汇报给上级。`
          )

          console.log(`[PhaseRunner] Worker ${workerId} completed:`, workerResult.slice(0, 200))
          this.dashboard.updateAgent(workerId, "completed", "任务完成")
        } catch (err) {
          console.error(`[PhaseRunner] Worker ${workerId} failed:`, err)
          this.dashboard.updateAgent(workerId, "blocked", `失败: ${(err as Error).message}`)
        }
      })()

      workerTaskPromises.push(promise)
    }

    await Promise.all(workerTaskPromises)

    this.dashboard.updateAgent(config.leader, "completed", "阶段完成")
    this.dashboard.updatePhase(config.name + "_done")

    return {
      status: "completed",
      leader: config.leader,
      workers: Object.fromEntries(
        config.workers.map(id => [id, { agentId: id, status: "completed" as const }])
      ),
      output: leaderResult,
      artifacts: [],
      startedAt: Date.now(),
      completedAt: Date.now(),
    }
  }
}
