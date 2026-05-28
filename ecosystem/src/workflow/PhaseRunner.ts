import type { PhaseConfig, PhaseResult, WorkerResult } from "../core/types.js"
import type { SessionManager } from "../infrastructure/SessionManager.js"
import type { EcosystemEventBus } from "../infrastructure/EventBus.js"
import type { Router } from "../infrastructure/Router.js"
import type { Dashboard } from "../infrastructure/Dashboard.js"

export class PhaseRunner {
  private readonly agentTimeoutMs = 10 * 60_000

  constructor(
    private sessionManager: SessionManager,
    private eventBus: EcosystemEventBus,
    private router: Router,
    private dashboard: Dashboard
  ) {}

  async run(config: PhaseConfig): Promise<PhaseResult> {
    const startedAt = Date.now()
    console.log(`\n[PhaseRunner] Starting phase: ${config.name}`)
    this.dashboard.updatePhase(config.name)

    const leaderProfile = this.router.getAgent(config.leader)
    if (!leaderProfile) {
      const message = `Leader not registered: ${config.leader}`
      this.dashboard.updateAgent(config.leader, "blocked", message)
      return {
        status: "blocked",
        leader: config.leader,
        workers: {},
        output: message,
        artifacts: [],
        startedAt,
        completedAt: Date.now(),
      }
    }
    this.dashboard.updateAgent(config.leader, "working", "接收任务")

    let leaderSession: string
    try {
      leaderSession = await this.withTimeout(
        this.sessionManager.createSession(leaderProfile),
        `create leader session: ${config.leader}`
      )
    } catch (err) {
      const message = (err as Error).message
      this.dashboard.updateAgent(config.leader, "blocked", message)
      return {
        status: "blocked",
        leader: config.leader,
        workers: {},
        output: message,
        artifacts: [],
        startedAt,
        completedAt: Date.now(),
      }
    }

    const taskContent = typeof config.task === "string"
      ? config.task
      : JSON.stringify(config.task, null, 2)

    try {
      await this.withTimeout(
        this.sessionManager.injectContext(
          leaderSession,
          leaderProfile,
          `你负责的阶段: ${config.name}\n\n${taskContent}`,
          config.injectContext
            ? `\n## 附加信息\n${JSON.stringify(config.injectContext, null, 2)}`
            : undefined
        ),
        `inject leader context: ${config.leader}`
      )
    } catch (err) {
      const message = (err as Error).message
      this.dashboard.updateAgent(config.leader, "blocked", message)
      return {
        status: "blocked",
        leader: config.leader,
        workers: {},
        output: message,
        artifacts: [],
        startedAt,
        completedAt: Date.now(),
      }
    }

    this.dashboard.updateAgent(config.leader, "working", "分析任务，准备分配")

    let leaderResult: string
    try {
      leaderResult = await this.withTimeout(
        this.sessionManager.sendTask(
          leaderSession,
          `请分析任务并分配给你的团队成员。你有以下成员: ${config.workers.join(", ")}。\n` +
          `对于每个成员，请使用 tell_upper 工具说明分配给他们的具体任务。\n` +
          `完成后，使用 tell_upper 汇报整体分配方案。`
        ),
        `leader task: ${config.leader}`
      )
    } catch (err) {
      const message = (err as Error).message
      this.dashboard.updateAgent(config.leader, "blocked", message)
      return {
        status: "blocked",
        leader: config.leader,
        workers: {},
        output: message,
        artifacts: [],
        startedAt,
        completedAt: Date.now(),
      }
    }

    console.log(`[PhaseRunner] Leader ${config.leader} result:`, leaderResult.slice(0, 200))

    const workerTaskPromises = config.workers.map(async (workerId): Promise<WorkerResult> => {
      const workerProfile = this.router.getAgent(workerId)
      if (!workerProfile) {
        const message = `Worker not registered: ${workerId}`
        this.dashboard.updateAgent(workerId, "blocked", message)
        return { agentId: workerId, status: "blocked", error: message }
      }

      this.dashboard.updateAgent(workerId, "working", "执行任务")

      try {
        const workerSession = await this.withTimeout(
          this.sessionManager.createSession(workerProfile),
          `create worker session: ${workerId}`
        )

        await this.withTimeout(
          this.sessionManager.injectContext(
            workerSession,
            workerProfile,
            `阶段: ${config.name}\n你的上级已分配任务给你。请根据上下文中的信息执行任务。\n完成后使用 tell_upper 汇报结果。`
          ),
          `inject worker context: ${workerId}`
        )

        const workerResult = await this.withTimeout(
          this.sessionManager.sendTask(
            workerSession,
            `请执行你的任务。完成后使用 tell_upper(content, status="completed", artifacts=[产出物路径]) 汇报给上级。`
          ),
          `worker task: ${workerId}`
        )

        console.log(`[PhaseRunner] Worker ${workerId} completed:`, workerResult.slice(0, 200))
        this.dashboard.updateAgent(workerId, "completed", "任务完成")
        return {
          agentId: workerId,
          status: "completed",
          sessionId: workerSession,
          output: workerResult,
        }
      } catch (err) {
        const message = (err as Error).message
        console.error(`[PhaseRunner] Worker ${workerId} failed:`, err)
        this.dashboard.updateAgent(workerId, "blocked", `失败: ${message}`)
        return { agentId: workerId, status: "blocked", error: message }
      }
    })

    const workerResults = await Promise.all(workerTaskPromises)
    const workers = Object.fromEntries(workerResults.map(result => [result.agentId, result]))
    const blocked = workerResults.filter(result => result.status === "blocked")

    if (blocked.length > 0) {
      const message = `阶段 ${config.name} 有 ${blocked.length} 个 Agent 失败: ${blocked.map(result => result.agentId).join(", ")}`
      this.dashboard.updateAgent(config.leader, "blocked", message)
      this.dashboard.updatePhase(config.name + "_blocked")
      return {
        status: "blocked",
        leader: config.leader,
        workers,
        output: [leaderResult, message].join("\n\n"),
        artifacts: [],
        startedAt,
        completedAt: Date.now(),
      }
    }

    this.dashboard.updateAgent(config.leader, "completed", "阶段完成")
    this.dashboard.updatePhase(config.name + "_done")

    return {
      status: "completed",
      leader: config.leader,
      workers,
      output: leaderResult,
      artifacts: [],
      startedAt,
      completedAt: Date.now(),
    }
  }

  private async withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${label} timed out after ${Math.floor(this.agentTimeoutMs / 1000)}s`))
      }, this.agentTimeoutMs)
    })

    try {
      return await Promise.race([promise, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
