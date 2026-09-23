import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { Client, type ClientChannel, type ConnectConfig } from "ssh2"
import type { ExecResult, InteractiveSessionInfo, PtyOutputChunk, SSHAuthProfile } from "./types.js"
import { stripAnsi } from "./strip-ansi.js"
import { SFTPManager } from "./sftp-manager.js"
import { JobManager } from "./job-manager.js"

export interface SSHSessionOptions {
  profile?: SSHAuthProfile
  host?: string
  port?: number
  username?: string
  password?: string
  privateKey?: string
  privateKeyPath?: string
  passphrase?: string
  keepaliveInterval?: number
}

export class SSHSession {
  public readonly id: string
  public readonly host: string
  public readonly port: number
  public readonly username: string
  public currentPtyUser?: string
  public connectedAt: number = 0
  public lastActiveAt: number = 0

  private client: Client
  private isConnected = false
  private shellChannel: ClientChannel | null = null
  private outputBuffer: PtyOutputChunk[] = []
  private maxBufferSize = 2000

  public sftp: SFTPManager
  public jobs: JobManager

  // For waiting on commands inside interactive shell
  private onDataCallbacks: Set<(chunk: PtyOutputChunk) => void> = new Set()

  constructor(id: string, options: SSHSessionOptions) {
    this.id = id
    this.client = new Client()
    this.sftp = new SFTPManager(this.client)
    this.jobs = new JobManager(this)
    this.host = options.host || options.profile?.host || "localhost"
    this.port = options.port || options.profile?.port || 22
    this.username = options.username || options.profile?.username || os.userInfo().username
  }

  async connect(options: SSHSessionOptions): Promise<void> {
    const profile = options.profile

    const connectConfig: ConnectConfig = {
      host: options.host || profile?.host || "localhost",
      port: options.port || profile?.port || 22,
      username: options.username || profile?.username || os.userInfo().username,
      keepaliveInterval: options.keepaliveInterval || 10000,
      keepaliveCountMax: 3,
      readyTimeout: 20000,
    }

    const password = options.password || profile?.password
    if (password) {
      connectConfig.password = password
    }

    const privateKey = options.privateKey || profile?.privateKey
    const privateKeyPath = options.privateKeyPath || profile?.privateKeyPath
    // Passphrase can be supplied directly, via profile, or via environment variable
    const passphrase =
      options.passphrase ||
      profile?.passphrase ||
      process.env.SSH_PASSPHRASE ||
      (profile?.name ? process.env[`SSH_PASSPHRASE_${profile.name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`] : undefined)

    if (privateKey) {
      connectConfig.privateKey = privateKey
      if (passphrase) connectConfig.passphrase = passphrase
    } else if (privateKeyPath) {
      const resolvedPath = privateKeyPath.startsWith("~")
        ? path.join(os.homedir(), privateKeyPath.slice(1))
        : privateKeyPath
      if (fs.existsSync(resolvedPath)) {
        try {
          connectConfig.privateKey = fs.readFileSync(resolvedPath)
          if (passphrase) connectConfig.passphrase = passphrase
        } catch (e: any) {
          throw new Error(`Failed to read private key at '${resolvedPath}': ${e.message}`)
        }
      } else {
        throw new Error(`Private key file not found at: '${resolvedPath}'`)
      }
    } else if (!password) {
      // Try default SSH keys if no password or key is provided
      const defaultKeys = ["id_rsa", "id_ed25519", "id_ecdsa"]
      for (const keyName of defaultKeys) {
        const keyFile = path.join(os.homedir(), ".ssh", keyName)
        if (fs.existsSync(keyFile)) {
          try {
            connectConfig.privateKey = fs.readFileSync(keyFile)
            if (passphrase) connectConfig.passphrase = passphrase
            break
          } catch {}
        }
      }
    }

    // Windows / Unix ssh-agent support if available
    const agentSock = process.env.SSH_AUTH_SOCK
    if (agentSock && !connectConfig.privateKey && !connectConfig.password) {
      connectConfig.agent = agentSock
    }

    return new Promise<void>((resolve, reject) => {
      this.client
        .on("ready", () => {
          this.isConnected = true
          this.connectedAt = Date.now()
          this.lastActiveAt = Date.now()
          resolve()
        })
        .on("error", (err) => {
          this.isConnected = false
          reject(err)
        })
        .on("close", () => {
          this.isConnected = false
          this.shellChannel = null
        })
        .connect(connectConfig)
    })
  }

  isOpen(): boolean {
    return this.isConnected
  }

  hasPty(): boolean {
    return this.shellChannel !== null && !this.shellChannel.destroyed
  }

  getInfo(): InteractiveSessionInfo {
    return {
      id: this.id,
      host: this.host,
      username: this.username,
      port: this.port,
      connectedAt: this.connectedAt,
      lastActiveAt: this.lastActiveAt,
      hasActivePty: this.hasPty(),
    }
  }

  // --- Discrete Exec Channel (One-shot command execution over multiplexed SSH) ---
  async exec(command: string, timeoutMs: number = 60000): Promise<ExecResult> {
    if (!this.isConnected) {
      throw new Error(`SSH Session '${this.id}' is not connected.`)
    }
    this.lastActiveAt = Date.now()

    const startTime = Date.now()

    return new Promise<ExecResult>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null

      this.client.exec(command, (err, stream) => {
        if (err) return reject(err)
        if (!stream) return reject(new Error("SSH channel creation failed: empty stream."))

        let stdout = ""
        let stderr = ""
        let exitCode: number | null = null
        let exitSignal: string | undefined = undefined

        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            stream.close()
            reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`))
          }, timeoutMs)
        }

        stream
          .on("data", (data: Buffer) => {
            stdout += data.toString("utf-8")
          })
          .stderr.on("data", (data: Buffer) => {
            stderr += data.toString("utf-8")
          })

        stream.on("close", (code: number, signal?: string) => {
          if (timer) clearTimeout(timer)
          exitCode = code
          exitSignal = signal
          this.lastActiveAt = Date.now()
          resolve({
            stdout: stripAnsi(stdout),
            stderr: stripAnsi(stderr),
            exitCode,
            signal: exitSignal,
            durationMs: Date.now() - startTime,
            executedAs: this.username,
          })
        })

        stream.on("error", (err: any) => {
          if (timer) clearTimeout(timer)
          reject(err)
        })
      })
    })
  }

  // --- Persistent Interactive PTY Shell ---
  async startPty(env?: Record<string, string>): Promise<void> {
    if (!this.isConnected) {
      throw new Error(`SSH Session '${this.id}' is not connected.`)
    }
    if (this.hasPty()) {
      return
    }

    return new Promise<void>((resolve, reject) => {
      const defaultEnv: Record<string, string> = {
        TERM: "dumb",
        PAGER: "cat",
        GIT_PAGER: "cat",
        SYSTEMD_PAGER: "cat",
        CI: "1",
        NO_COLOR: "1",
        LANG: "en_US.UTF-8",
        ...(env || {}),
      }

      this.client.shell(
        {
          term: "xterm-256color",
          rows: 40,
          cols: 120,
        },
        {
          env: defaultEnv,
        },
        (err, stream) => {
          if (err) return reject(err)

          this.shellChannel = stream

          stream.on("data", (data: Buffer) => {
            const str = data.toString("utf-8")
            const chunk: PtyOutputChunk = {
              stream: "stdout",
              data: str,
              timestamp: Date.now(),
            }
            this.appendOutput(chunk)
            for (const cb of this.onDataCallbacks) {
              try {
                cb(chunk)
              } catch (e) {
                console.error("[oc-ssh] Error in pty listener:", e)
              }
            }
          })

          stream.stderr.on("data", (data: Buffer) => {
            const str = data.toString("utf-8")
            const chunk: PtyOutputChunk = {
              stream: "stderr",
              data: str,
              timestamp: Date.now(),
            }
            this.appendOutput(chunk)
            for (const cb of this.onDataCallbacks) {
              try {
                cb(chunk)
              } catch (e) {
                console.error("[oc-ssh] Error in pty listener:", e)
              }
            }
          })

          stream.on("close", () => {
            this.shellChannel = null
          })

          resolve()
        }
      )
    })
  }

  private appendOutput(chunk: PtyOutputChunk) {
    this.outputBuffer.push(chunk)
    if (this.outputBuffer.length > this.maxBufferSize) {
      this.outputBuffer.splice(0, this.outputBuffer.length - this.maxBufferSize)
    }
  }

  writePty(input: string): void {
    if (!this.hasPty()) {
      throw new Error(`Session '${this.id}' has no active PTY shell. Call ssh_session_open first.`)
    }
    this.lastActiveAt = Date.now()
    this.shellChannel?.write(input)
  }

  getRecentOutput(linesLimit: number = 100): string {
    const raw = this.outputBuffer.map((c) => c.data).join("")
    const cleaned = stripAnsi(raw)
    const lines = cleaned.split(/\r?\n/)
    return lines.slice(-linesLimit).join("\n")
  }

  clearOutput(): void {
    this.outputBuffer = []
  }

  /**
   * Run a command inside the persistent PTY and wait for a completion marker or prompt.
   * Uses a sentinel token to reliably detect when command has finished in the interactive shell.
   */
  async runInPty(command: string, timeoutMs: number = 30000): Promise<string> {
    if (!this.hasPty()) {
      await this.startPty()
    }

    const marker = `__OC_SSH_SENTINEL_${Math.random().toString(36).substring(2, 9)}__`
    let captured = ""
    let resolved = false

    return new Promise<string>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null

      const listener = (chunk: PtyOutputChunk) => {
        captured += chunk.data
        if (captured.includes(marker)) {
          if (!resolved) {
            resolved = true
            cleanup()
            const cleaned = stripAnsi(captured)
              .replace(new RegExp(`echo\\s+["']?${marker}["']?`, "g"), "")
              .replace(new RegExp(marker, "g"), "")
              .trim()
            resolve(cleaned)
          }
        }
      }

      const cleanup = () => {
        if (timer) clearTimeout(timer)
        this.onDataCallbacks.delete(listener)
      }

      this.onDataCallbacks.add(listener)

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          cleanup()
          // Return whatever was captured so far even on timeout so agent can see prompt
          resolve(captured.trim() + `\n[Wait timed out after ${timeoutMs}ms]`)
        }, timeoutMs)
      }

      // Execute command followed by echo marker
      const fullCmd = `${command}\necho "${marker}"\n`
      this.writePty(fullCmd)
    })
  }

  /**
   * Switch the current user in the persistent PTY shell (su or sudo -i -u).
   * Automatically handles password prompt if a password is supplied.
   */
  async switchUserInPty(
    targetUser: string = "root",
    password?: string,
    timeoutMs: number = 10000
  ): Promise<{ success: boolean; user: string; output: string }> {
    if (!this.hasPty()) {
      await this.startPty()
    }

    const cmd = targetUser === "root" ? "sudo -i || su -" : `sudo -i -u ${targetUser} || su - ${targetUser}`
    let captured = ""

    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | null = null
      let passwordSent = false

      const listener = (chunk: PtyOutputChunk) => {
        captured += chunk.data
        const lower = captured.toLowerCase()

        // If prompted for password and password was provided, send it
        if (!passwordSent && (lower.includes("[sudo] password") || lower.includes("password:") || lower.includes("passphrase:"))) {
          if (password) {
            passwordSent = true
            this.writePty(`${password}\n`)
          }
        }
      }

      const cleanup = () => {
        if (timer) clearTimeout(timer)
        this.onDataCallbacks.delete(listener)
      }

      this.onDataCallbacks.add(listener)

      // Send the su/sudo command
      this.writePty(`${cmd}\n`)

      timer = setTimeout(async () => {
        cleanup()
        // Check whoami now in the PTY
        try {
          const whoamiRes = await this.runInPty("whoami", 5000)
          const current = whoamiRes.trim().split("\n").pop()?.trim() || ""
          const isTarget = current === targetUser || (targetUser === "root" && current === "root")
          if (isTarget) {
            this.currentPtyUser = current
          }
          resolve({
            success: isTarget,
            user: current,
            output: stripAnsi(captured).trim(),
          })
        } catch (e: any) {
          resolve({
            success: false,
            user: "unknown",
            output: stripAnsi(captured).trim(),
          })
        }
      }, timeoutMs)
    })
  }

  async close(): Promise<void> {
    if (this.sftp) {
      try {
        this.sftp.close()
      } catch {}
    }
    if (this.shellChannel) {
      try {
        this.shellChannel.close()
      } catch {}
      this.shellChannel = null
    }
    if (this.client) {
      try {
        this.client.end()
      } catch {}
    }
    this.isConnected = false
    this.outputBuffer = []
    this.onDataCallbacks.clear()
  }
}
