import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import SSHConfig from "ssh-config"
import type { SSHAuthProfile } from "./types.js"

export interface ProfileStore {
  get(name: string): Promise<SSHAuthProfile | undefined>
  list(): Promise<SSHAuthProfile[]>
  save(profile: SSHAuthProfile): Promise<void>
  remove(name: string): Promise<boolean>
}

export function parseSshConfig(): SSHAuthProfile[] {
  const sshConfigPath = path.join(os.homedir(), ".ssh", "config")
  if (!fs.existsSync(sshConfigPath)) {
    return []
  }

  try {
    const content = fs.readFileSync(sshConfigPath, "utf-8")
    const parsed = SSHConfig.parse(content)
    const profiles: SSHAuthProfile[] = []

    for (const section of parsed) {
      if (section.type === 1 && section.param === "Host") {
        const hostPattern = String(section.value).trim()
        // Skip wildcards like Host *
        if (hostPattern === "*" || hostPattern.includes("*") || hostPattern.includes("?")) {
          continue
        }

        const config = parsed.compute(hostPattern)
        const host = config.HostName ? String(config.HostName) : hostPattern
        const port = config.Port ? parseInt(String(config.Port), 10) : 22
        const user = config.User ? String(config.User) : undefined

        let identityFile: string | undefined
        if (config.IdentityFile) {
          const rawId = Array.isArray(config.IdentityFile)
            ? String(config.IdentityFile[0])
            : String(config.IdentityFile)
          identityFile = rawId.startsWith("~") ? path.join(os.homedir(), rawId.slice(1)) : rawId
        }

        profiles.push({
          name: hostPattern,
          host,
          port: isNaN(port) ? 22 : port,
          username: user,
          privateKeyPath: identityFile,
          description: `Imported from ~/.ssh/config (${hostPattern})`,
        })
      }
    }

    return profiles
  } catch (err) {
    console.error("[oc-ssh] Error reading ~/.ssh/config:", err)
    return []
  }
}

export class ConfigManager implements ProfileStore {
  private customProfiles = new Map<string, SSHAuthProfile>()
  private storageDir: string
  private customProfilesFile: string

  constructor(customStorageDir?: string) {
    this.storageDir =
      customStorageDir ||
      path.join(
        process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
        "opencode",
        "ssh"
      )
    this.customProfilesFile = path.join(this.storageDir, "profiles.json")
    this.loadCustomProfiles()
  }

  private loadCustomProfiles() {
    try {
      if (fs.existsSync(this.customProfilesFile)) {
        const data = JSON.parse(fs.readFileSync(this.customProfilesFile, "utf-8"))
        if (Array.isArray(data)) {
          for (const p of data) {
            if (p.name) this.customProfiles.set(p.name, p)
          }
        }
      }
    } catch (e) {
      console.error("[oc-ssh] Failed to load custom profiles:", e)
    }
  }

  private saveCustomProfiles() {
    try {
      if (!fs.existsSync(this.storageDir)) {
        fs.mkdirSync(this.storageDir, { recursive: true })
      }
      fs.writeFileSync(
        this.customProfilesFile,
        JSON.stringify(Array.from(this.customProfiles.values()), null, 2),
        "utf-8"
      )
    } catch (e) {
      console.error("[oc-ssh] Failed to write custom profiles:", e)
    }
  }

  async list(): Promise<SSHAuthProfile[]> {
    const sshProfiles = parseSshConfig()
    const map = new Map<string, SSHAuthProfile>()

    for (const p of sshProfiles) {
      map.set(p.name, p)
    }
    // Custom profiles override ~/.ssh/config if same name
    for (const [name, p] of this.customProfiles.entries()) {
      map.set(name, p)
    }

    return Array.from(map.values())
  }

  async get(name: string): Promise<SSHAuthProfile | undefined> {
    if (this.customProfiles.has(name)) {
      return this.customProfiles.get(name)
    }
    const sshProfiles = parseSshConfig()
    const found = sshProfiles.find((p) => p.name.toLowerCase() === name.toLowerCase())
    if (found) return found

    return undefined
  }

  async save(profile: SSHAuthProfile): Promise<void> {
    this.customProfiles.set(profile.name, profile)
    this.saveCustomProfiles()
  }

  async remove(name: string): Promise<boolean> {
    const deleted = this.customProfiles.delete(name)
    if (deleted) {
      this.saveCustomProfiles()
    }
    return deleted
  }
}
