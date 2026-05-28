import type { AgentProfile, WorkflowState, WorkflowPhase, PhaseResult } from "../core/types.js"
import type { OpenCodeBridge } from "../infrastructure/OpenCodeBridge.js"
import type { SessionManager } from "../infrastructure/SessionManager.js"
import type { EcosystemEventBus } from "../infrastructure/EventBus.js"
import type { Router } from "../infrastructure/Router.js"
import type { WorkspaceManager } from "../infrastructure/WorkspaceManager.js"
import type { Dashboard } from "../infrastructure/Dashboard.js"
import { PhaseRunner } from "./PhaseRunner.js"
import { writeFile, readFile, mkdir } from "fs/promises"
import { dirname } from "path"

export class Orchestrator {
  private state: WorkflowState
  private phaseRunner: PhaseRunner
  private startTime = Date.now()
  private statePath: string

  private PROFILES: AgentProfile[] = [
    { id: "planning-director", name: "策划总经理", role: "策划总经理", team: "planning", level: 1, superior: undefined, skillName: "planning-director" },
    { id: "planner-a", name: "策划者A", role: "策划者", team: "planning", level: 2, superior: "planning-director", skillName: "planner" },
    { id: "planner-b", name: "策划者B", role: "策划者", team: "planning", level: 2, superior: "planning-director", skillName: "planner" },
    { id: "chief-architect", name: "总架构师", role: "总架构师", team: "development", level: 1, superior: undefined, skillName: "chief-architect" },
    { id: "developer-a", name: "开发者A", role: "开发者", team: "development", level: 2, superior: "chief-architect", skillName: "developer" },
    { id: "developer-b", name: "开发者B", role: "开发者", team: "development", level: 2, superior: "chief-architect", skillName: "developer" },
    { id: "developer-c", name: "开发者C", role: "开发者", team: "development", level: 2, superior: "chief-architect", skillName: "developer" },
    { id: "chief-reviewer", name: "总审核者", role: "总审核者", team: "qa", level: 1, superior: undefined, skillName: "chief-reviewer" },
    { id: "reviewer-a", name: "审核员A", role: "审核员", team: "qa", level: 2, superior: "chief-reviewer", skillName: "reviewer" },
    { id: "tester-a", name: "测试员A", role: "测试员", team: "qa", level: 2, superior: "chief-reviewer", skillName: "tester" },
  ]

  constructor(
    private bridge: OpenCodeBridge,
    private sessionManager: SessionManager,
    private eventBus: EcosystemEventBus,
    private router: Router,
    private workspaceManager: WorkspaceManager,
    private dashboard: Dashboard,
    statePath: string,
    private maxIterations = 3
  ) {
    this.statePath = statePath
    this.state = {
      phase: "init",
      requirement: "",
      iteration: 0,
      maxIterations,
      phases: {},
      startedAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.phaseRunner = new PhaseRunner(sessionManager, eventBus, router, dashboard)
  }

  async initialize(): Promise<void> {
    this.router.registerAll(this.PROFILES)
    await this.eventBus.recover()
    await this.recoverState()

    this.eventBus.on("event:*", (event) => {
      this.dashboard.updateAgent(event.from, event.payload.status, event.payload.content.slice(0, 60))
    })

    console.log("[Orchestrator] Initialized with", this.PROFILES.length, "agents")
  }

  async run(requirement: string): Promise<WorkflowState> {
    this.state.requirement = requirement
    this.state.startedAt = Date.now()
    this.state.phase = "planning"
    this.dashboard.updatePhase("planning")
    this.dashboard.updateAgent("system", "info", `收到需求: ${requirement}`)

    // Phase 1: 策划
    const prd = await this.phaseRunner.run({
      name: "策划",
      leader: "planning-director",
      workers: ["planner-a", "planner-b"],
      task: `用户需求:\n${requirement}\n\n请分析需求并编写PRD（产品需求文档），包含用户故事和验收标准。`,
    })
    this.state.phases.planning = prd
    this.state.phase = "developing"
    this.dashboard.updateArtifact("prd", ".ecosystem/planning/prd.md")
    await this.saveState()

    // Phase 2: 架构 + 开发
    const code = await this.phaseRunner.run({
      name: "开发",
      leader: "chief-architect",
      workers: ["developer-a", "developer-b", "developer-c"],
      task: `请根据以下PRD进行架构设计并分配开发任务:\n\n${prd.output ?? "PRD已完成，请查看产出物"}`,
    })
    this.state.phases.developing = code
    this.state.phase = "reviewing"
    this.dashboard.updateArtifact("code", ".ecosystem/development/merged")
    await this.saveState()

    // Phase 3+4: 审查 + 迭代
    let reviewResult = await this.runReviewPhase(code)
    let iteration = 0

    while (reviewResult.hasIssues && iteration < this.maxIterations) {
      iteration++
      this.state.iteration = iteration
      this.state.phase = "iterating"
      this.dashboard.updatePhase("iterating", iteration)

      const fix = await this.phaseRunner.run({
        name: `迭代修复 #${iteration}`,
        leader: "chief-architect",
        workers: ["developer-a", "developer-b", "developer-c"],
        task: `请根据以下审查反馈修复代码:\n\n${reviewResult.feedback}`,
      })
      this.state.phases[`iteration-${iteration}`] = fix

      reviewResult = await this.runReviewPhase(fix)
    }

    this.state.phase = reviewResult.hasIssues ? "escalated" : "done"
    this.state.updatedAt = Date.now()
    this.dashboard.updatePhase(this.state.phase)
    await this.saveState()

    if (this.state.phase === "done") {
      this.dashboard.updateAgent("system", "completed", "所有阶段完成!")
    } else {
      this.dashboard.updateAgent("system", "blocked", `超过最大迭代次数(${this.maxIterations})，需要人工介入`)
    }

    return this.state
  }

  private async runReviewPhase(codeResult: PhaseResult): Promise<{ hasIssues: boolean; feedback: string }> {
    const reviewResult = await this.phaseRunner.run({
      name: "审核",
      leader: "chief-reviewer",
      workers: ["reviewer-a", "tester-a"],
      task: `请审查以下开发结果并运行测试:\n\n${codeResult.output ?? "代码已提交，请审查"}`,
    })
    this.state.phases.reviewing = reviewResult

    const output = reviewResult.output ?? ""
    const hasIssues = output.toLowerCase().includes("fail") ||
                      output.toLowerCase().includes("issue") ||
                      output.toLowerCase().includes("问题") ||
                      output.toLowerCase().includes("blocked")

    return { hasIssues, feedback: output }
  }

  private async saveState(): Promise<void> {
    try {
      await mkdir(dirname(this.statePath), { recursive: true })
      await writeFile(this.statePath, JSON.stringify(this.state, null, 2))
    } catch (err) {
      console.error("[Orchestrator] saveState failed:", err)
    }
  }

  private async recoverState(): Promise<void> {
    try {
      const data = await readFile(this.statePath, "utf-8")
      this.state = JSON.parse(data)
      console.log("[Orchestrator] Recovered state, phase:", this.state.phase)
    } catch {
      // fresh state
    }
  }

  getProfiles(): AgentProfile[] {
    return this.PROFILES
  }

  getState(): WorkflowState {
    return { ...this.state }
  }
}
