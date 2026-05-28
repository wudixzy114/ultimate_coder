import { createOpencode, createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk"

export class OpenCodeBridge {
  private client: OpencodeClient | null = null
  private serverUrl: string | null = null

  async start(port = 4096): Promise<OpencodeClient> {
    const { client, server } = await createOpencode({
      port,
      hostname: "127.0.0.1",
    })

    this.client = client
    this.serverUrl = server.url

    console.log(`[OpenCodeBridge] Server started at ${server.url}`)

    try {
      const health = await (client as any).global.health()
      console.log(`[OpenCodeBridge] Health:`, health)
    } catch {
      console.log(`[OpenCodeBridge] Health check skipped`)
    }

    return client
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
}
