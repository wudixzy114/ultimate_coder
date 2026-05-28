import type { AgentProfile, TeamName } from "../core/types.js"

export class Router {
  private agents: Map<string, AgentProfile> = new Map()

  register(profile: AgentProfile): void {
    this.agents.set(profile.id, profile)
  }

  registerAll(profiles: AgentProfile[]): void {
    for (const p of profiles) this.register(p)
  }

  getAgent(agentId: string): AgentProfile | undefined {
    return this.agents.get(agentId)
  }

  getSuperior(agentId: string): string | null {
    const agent = this.agents.get(agentId)
    return agent?.superior ?? null
  }

  getSubordinates(agentId: string): string[] {
    return [...this.agents.values()]
      .filter(a => a.superior === agentId)
      .map(a => a.id)
  }

  getTeamMembers(team: TeamName): string[] {
    return [...this.agents.values()]
      .filter(a => a.team === team)
      .map(a => a.id)
  }

  getTeamLead(team: TeamName): string | null {
    return [...this.agents.values()]
      .find(a => a.team === team && a.level === 1)?.id ?? null
  }

  getByTeamAndLevel(team: TeamName, level: number): AgentProfile[] {
    return [...this.agents.values()]
      .filter(a => a.team === team && a.level === level)
  }

  getAll(): AgentProfile[] {
    return [...this.agents.values()]
  }

  resolve(agentId: string, toolName: string): string | null {
    switch (toolName) {
      case "tell_upper":
        return this.getSuperior(agentId)
      default:
        return null
    }
  }
}
