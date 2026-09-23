export interface SSHAuthProfile {
  name: string
  host: string
  port?: number
  username?: string
  privateKeyPath?: string
  privateKey?: string
  passphrase?: string
  password?: string
  agentForward?: boolean
  description?: string
}

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number | null
  signal?: string
  durationMs: number
  executedAs?: string
}

export interface PtyOutputChunk {
  stream: "stdout" | "stderr"
  data: string
  timestamp: number
}

export interface InteractiveSessionInfo {
  id: string
  host: string
  username: string
  port: number
  connectedAt: number
  lastActiveAt: number
  hasActivePty: boolean
  cwd?: string
  activeJob?: {
    id: string
    command: string
    startedAt: number
    running: boolean
  }
}
