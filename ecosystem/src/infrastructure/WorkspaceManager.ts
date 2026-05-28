import { execSync } from "child_process"
import { existsSync } from "fs"
import { join } from "path"

export class WorkspaceManager {
  private worktrees: Map<string, string> = new Map()

  constructor(private projectRoot: string) {}

  private exec(cmd: string): string {
    return execSync(cmd, { cwd: this.projectRoot, encoding: "utf-8" }).trim()
  }

  private execNoThrow(cmd: string): { stdout: string; exitCode: number } {
    try {
      const stdout = execSync(cmd, { cwd: this.projectRoot, encoding: "utf-8" }).trim()
      return { stdout, exitCode: 0 }
    } catch (err: any) {
      return { stdout: err.stdout ?? "", exitCode: err.status ?? 1 }
    }
  }

  async allocate(agentId: string, taskName: string): Promise<string> {
    const sanitized = taskName.replace(/\s+/g, "-").toLowerCase()
    const branch = `feat/${agentId}-${sanitized}`
    const worktreePath = join(this.projectRoot, ".worktrees", `${agentId}-${sanitized}`)

    if (existsSync(worktreePath)) {
      this.worktrees.set(agentId, worktreePath)
      return worktreePath
    }

    try {
      this.exec(`git worktree add "${worktreePath}" -b ${branch}`)
      this.worktrees.set(agentId, worktreePath)
      return worktreePath
    } catch (err) {
      console.error(`[WorkspaceManager] Failed to create worktree for ${agentId}:`, err)
      throw err
    }
  }

  getWorkspace(agentId: string): string | undefined {
    return this.worktrees.get(agentId)
  }

  async merge(agentId: string, message: string): Promise<{ success: boolean; conflicts?: string[] }> {
    const worktreePath = this.worktrees.get(agentId)
    if (!worktreePath) return { success: false, conflicts: ["No worktree found"] }

    try {
      this.execNoThrow(`git add -A`)
      this.execNoThrow(`git commit -m "${message}"`)

      const branch = this.exec(`git rev-parse --abbrev-ref HEAD`)
      this.execNoThrow(`git checkout main`)
      const result = this.execNoThrow(`git merge ${branch} --no-ff -m "merge: ${message}"`)

      if (result.exitCode !== 0) {
        const conflicts = this.execNoThrow(`git diff --name-only --diff-filter=U`)
          .stdout.split("\n").filter(Boolean)
        this.execNoThrow(`git merge --abort`)
        return { success: false, conflicts }
      }

      return { success: true }
    } catch (err) {
      console.error(`[WorkspaceManager] Merge failed for ${agentId}:`, err)
      return { success: false, conflicts: [(err as Error).message] }
    }
  }

  async cleanup(agentId: string): Promise<void> {
    const worktreePath = this.worktrees.get(agentId)
    if (!worktreePath) return

    try {
      this.execNoThrow(`git worktree remove "${worktreePath}" --force`)
      this.worktrees.delete(agentId)
    } catch (err) {
      console.error(`[WorkspaceManager] Cleanup failed for ${agentId}:`, err)
    }
  }

  async cleanupAll(): Promise<void> {
    for (const agentId of this.worktrees.keys()) {
      await this.cleanup(agentId)
    }
  }
}
