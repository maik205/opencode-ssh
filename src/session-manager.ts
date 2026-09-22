import { SSHSession, type SSHSessionOptions } from "./ssh-session.js"
import { ConfigManager } from "./config.js"
import type { InteractiveSessionInfo, SSHAuthProfile } from "./types.js"

export class SessionManager {
  private sessions = new Map<string, SSHSession>()
  private defaultSessionId: string | null = null
  public configManager: ConfigManager

  constructor(configManager?: ConfigManager) {
    this.configManager = configManager || new ConfigManager()
  }

  async getOrCreateSession(
    sessionIdOrProfileName?: string,
    options?: Partial<SSHSessionOptions>
  ): Promise<SSHSession> {
    const id = sessionIdOrProfileName || this.defaultSessionId || "default"

    if (this.sessions.has(id)) {
      const existing = this.sessions.get(id)!
      if (existing.isOpen()) {
        return existing
      } else {
        // Stale / closed session
        await existing.close()
        this.sessions.delete(id)
      }
    }

    // Try resolving as an auth profile
    let profile: SSHAuthProfile | undefined = options?.profile
    if (!profile && sessionIdOrProfileName) {
      profile = await this.configManager.get(sessionIdOrProfileName)
    }

    const sessionOptions: SSHSessionOptions = {
      profile,
      host: options?.host,
      port: options?.port,
      username: options?.username,
      password: options?.password,
      privateKey: options?.privateKey,
      privateKeyPath: options?.privateKeyPath,
      passphrase: options?.passphrase,
    }

    const session = new SSHSession(id, sessionOptions)
    await session.connect(sessionOptions)

    this.sessions.set(id, session)
    if (!this.defaultSessionId) {
      this.defaultSessionId = id
    }

    return session
  }

  getSession(id?: string): SSHSession | undefined {
    const targetId = id || this.defaultSessionId
    if (!targetId) return undefined
    return this.sessions.get(targetId)
  }

  setDefaultSession(id: string): boolean {
    if (this.sessions.has(id)) {
      this.defaultSessionId = id
      return true
    }
    return false
  }

  listSessions(): InteractiveSessionInfo[] {
    const list: InteractiveSessionInfo[] = []
    for (const [id, s] of this.sessions.entries()) {
      if (s.isOpen()) {
        const info = s.getInfo()
        if (id === this.defaultSessionId) {
          ;(info as any).isDefault = true
        }
        list.push(info)
      }
    }
    return list
  }

  async closeSession(id: string): Promise<boolean> {
    const session = this.sessions.get(id)
    if (!session) return false

    await session.close()
    this.sessions.delete(id)

    if (this.defaultSessionId === id) {
      const next = this.sessions.keys().next().value
      this.defaultSessionId = next || null
    }

    return true
  }

  async closeAll(): Promise<void> {
    for (const session of this.sessions.values()) {
      await session.close()
    }
    this.sessions.clear()
    this.defaultSessionId = null
  }
}
