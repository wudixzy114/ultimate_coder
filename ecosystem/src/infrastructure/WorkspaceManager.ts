import { spawnSync } from "child_process"
import { existsSync } from "fs"
import { join } from "path"

export class WorkspaceManager {
  private worktrees: Map<string, string> = new Map()

  constructor(private projectRoot: string) {}

  private git(args: string[], cwd = this.projectRoot): string {
    const result = spawnSync("git", args, { cwd, encoding: "utf-8" })
    if (result.status !== 0) {
      throw new Error((result.stderr || result.stdout || `git ${args.join(" ")} failed`).trim())
    }
    return (result.stdout ?? "").trim()
  }

  private gitNoThrow(args: string[], cwd = this.projectRoot): { stdout: string; stderr: string; exitCode: number } {
    const result = spawnSync("git", args, { cwd, encoding: "utf-8" })
    return {
      stdout: (result.stdout ?? "").trim(),
      stderr: (result.stderr ?? "").trim(),
      exitCode: result.status ?? 1,
    }
  }

  async allocate(agentId: string, taskName: string): Promise<string> {
    const sanitized = taskName
      .replace(/[^\p{L}\p{N}._-]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase()
      .slice(0, 48) || "task"
    const branch = `feat/${agentId}-${sanitized}`
    const worktreePath = join(this.projectRoot, ".worktrees", `${agentId}-${sanitized}`)

    if (existsSync(worktreePath)) {
      this.worktrees.set(agentId, worktreePath)
      return worktreePath
    }

    try {
      this.git(["worktree", "add", worktreePath, "-b", branch])
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
      this.git(["add", "-A"], worktreePath)
      const commit = this.gitNoThrow(["commit", "-m", message], worktreePath)
      if (commit.exitCode !== 0 && !commit.stdout.includes("nothing to commit") && !commit.stderr.includes("nothing to commit")) {
        return { success: false, conflicts: [commit.stderr || commit.stdout || "Commit failed"] }
      }

      const branch = this.git(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath)
      const baseBranch = this.resolveBaseBranch()
      this.git(["checkout", baseBranch])
      const result = this.gitNoThrow(["merge", branch, "--no-ff", "-m", `merge: ${message}`])

      if (result.exitCode !== 0) {
        const conflicts = this.gitNoThrow(["diff", "--name-only", "--diff-filter=U"])
          .stdout.split("\n").filter(Boolean)
        this.gitNoThrow(["merge", "--abort"])
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
      this.gitNoThrow(["worktree", "remove", worktreePath, "--force"])
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

  private resolveBaseBranch(): string {
    if (this.gitNoThrow(["show-ref", "--verify", "--quiet", "refs/heads/main"]).exitCode === 0) return "main"
    if (this.gitNoThrow(["show-ref", "--verify", "--quiet", "refs/heads/master"]).exitCode === 0) return "master"
    const current = this.gitNoThrow(["rev-parse", "--abbrev-ref", "HEAD"]).stdout
    if (current && current !== "HEAD") return current
    throw new Error("Cannot resolve base branch")
  }
}
