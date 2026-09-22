import { SSHSession, type SSHSessionOptions } from "./ssh-session.js"
import { ConfigManager } from "./config.js"
import type { InteractiveSessionInfo, SSHAuthProfile } from "./types.js"

export class SessionManager {
  private sessions = new Map<string, SSHSession>()
  private sessionConfigs = new Map<string, SSHSessionOptions>()
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
        // Stale / closed session - close cleanly
        await existing.close()
        this.sessions.delete(id)
      }
    }

    // Try resolving as an auth profile
    let profile: SSHAuthProfile | undefined = options?.profile
    if (!profile && sessionIdOrProfileName) {
      profile = await this.configManager.get(sessionIdOrProfileName)
    }

    // Check previously stored config for auto-reconnect
    const cachedConfig = this.sessionConfigs.get(id)

    const sessionOptions: SSHSessionOptions = {
      profile: profile || cachedConfig?.profile,
      host: options?.host || cachedConfig?.host,
      port: options?.port || cachedConfig?.port,
      username: options?.username || cachedConfig?.username,
      password: options?.password || cachedConfig?.password,
      privateKey: options?.privateKey || cachedConfig?.privateKey,
      privateKeyPath: options?.privateKeyPath || cachedConfig?.privateKeyPath,
      passphrase: options?.passphrase || cachedConfig?.passphrase,
    }

    const session = new SSHSession(id, sessionOptions)
    await session.connect(sessionOptions)

    this.sessions.set(id, session)
    this.sessionConfigs.set(id, sessionOptions)

    if (!this.defaultSessionId) {
      this.defaultSessionId = id
    }

    return session
  }

  renameSession(oldId: string, newId: string): boolean {
    const session = this.sessions.get(oldId)
    if (!session || this.sessions.has(newId)) return false

    this.sessions.delete(oldId)
    ;(session as any).id = newId
    this.sessions.set(newId, session)

    const cfg = this.sessionConfigs.get(oldId)
    if (cfg) {
      this.sessionConfigs.delete(oldId)
      this.sessionConfigs.set(newId, cfg)
    }

    if (this.defaultSessionId === oldId) {
      this.defaultSessionId = newId
    }

    return true
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

  getDefaultSessionId(): string | null {
    return this.defaultSessionId
  }

  getAllOpenSessions(): SSHSession[] {
    return Array.from(this.sessions.values()).filter((s) => s.isOpen())
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
    this.sessionConfigs.delete(id)

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
    this.sessionConfigs.clear()
    this.defaultSessionId = null
  }
}
