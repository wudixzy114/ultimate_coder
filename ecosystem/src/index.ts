import { OpenCodeBridge } from "./infrastructure/OpenCodeBridge.js"
import { SessionManager } from "./infrastructure/SessionManager.js"
import { EcosystemEventBus } from "./infrastructure/EventBus.js"
import { Router } from "./infrastructure/Router.js"
import { WorkspaceManager } from "./infrastructure/WorkspaceManager.js"
import { Dashboard } from "./infrastructure/Dashboard.js"
import { createDefaultToolRegistry } from "./infrastructure/ToolRegistry.js"
import { Orchestrator } from "./workflow/Orchestrator.js"
import { join } from "path"

const PROJECT_ROOT = process.cwd()
const STATE_DIR = join(PROJECT_ROOT, ".ecosystem")

async function main() {
  const requirement = process.argv[2]
  if (!requirement) {
    console.error("用法: tsx src/index.ts \"你的需求描述\"")
    process.exit(1)
  }

  console.log("=== AI Agent Ecosystem ===")
  console.log(`需求: ${requirement}\n`)

  // 1. 初始化基础设施
  const bridge = new OpenCodeBridge()
  const client = await bridge.start(4096)

  const eventBus = new EcosystemEventBus(join(STATE_DIR, "events.jsonl"))
  const router = new Router()
  const workspaceManager = new WorkspaceManager(PROJECT_ROOT)
  const dashboard = new Dashboard(join(STATE_DIR, "dashboard.json"), requirement)
  const toolRegistry = createDefaultToolRegistry(join(STATE_DIR, "tools.json"))
  await toolRegistry.persist()

  const sessionManager = new SessionManager(client, eventBus, router, toolRegistry)

  // 2. 初始化Orchestrator
  const orchestrator = new Orchestrator(
    bridge,
    sessionManager,
    eventBus,
    router,
    workspaceManager,
    dashboard,
    join(STATE_DIR, "state.json")
  )
  await orchestrator.initialize()

  // 3. 运行
  dashboard.render()
  const finalState = await orchestrator.run(requirement)

  // 4. 输出结果
  console.log("\n=== 最终结果 ===")
  console.log("阶段:", finalState.phase)
  console.log("迭代次数:", finalState.iteration)
  console.log("各阶段结果:")
  for (const [name, result] of Object.entries(finalState.phases)) {
    console.log(`  ${name}: ${result.status}`)
  }

  await workspaceManager.cleanupAll()
  console.log("\n完成!")
}

main().catch(console.error)
