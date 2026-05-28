import { createOpencode, createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk"

export class OpenCodeBridge {
  private client: OpencodeClient | null = null
  private serverUrl: string | null = null

  async start(port = 4096): Promise<OpencodeClient> {
    let lastError: unknown

    for (let offset = 0; offset < 5; offset++) {
      const candidatePort = port + offset
      try {
        const { client, server } = await createOpencode({
          port: candidatePort,
          hostname: "127.0.0.1",
        })

        this.client = client
        this.serverUrl = server.url

        console.log(`[OpenCodeBridge] Server started at ${server.url}`)
        await this.healthCheck(client)
        return client
      } catch (err) {
        lastError = err
        console.error(`[OpenCodeBridge] Failed to start on port ${candidatePort}:`, (err as Error).message)
      }
    }

    throw new Error(`OpenCodeBridge failed to start after 5 ports: ${(lastError as Error | undefined)?.message ?? "unknown error"}`)
  }

  async connect(url: string): Promise<OpencodeClient> {
    this.client = createOpencodeClient({ baseUrl: url })
    this.serverUrl = url
    return this.client
  }

  getClient(): OpencodeClient {
    if (!this.client) throw new Error("OpenCodeBridge not initialized")
    return this.client
  }

  getUrl(): string {
    if (!this.serverUrl) throw new Error("OpenCodeBridge not initialized")
    return this.serverUrl
  }

  async getAgents() {
    const client = this.getClient()
    const result = await client.app.agents()
    return result
  }

  private async healthCheck(client: OpencodeClient): Promise<void> {
    try {
      const health = await (client as any).global.health()
      console.log(`[OpenCodeBridge] Health:`, health)
    } catch {
      console.log(`[OpenCodeBridge] Health check skipped`)
    }
  }
}
