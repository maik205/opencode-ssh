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

export interface SFTPFileEntry {
  name: string
  path: string
  type: "file" | "directory" | "symlink" | "other"
  size: number
  sizeFormatted: string
  permissions: string
  mode: string
  mtime: string
  mtimeMs: number
  atime: string
  atimeMs: number
  uid: number
  gid: number
  isDirectory: boolean
  isSymbolicLink: boolean
}

export interface SFTPStatResult {
  path: string
  exists: boolean
  type?: "file" | "directory" | "symlink" | "other"
  size?: number
  sizeFormatted?: string
  permissions?: string
  mode?: string
  mtime?: string
  mtimeMs?: number
  atime?: string
  atimeMs?: number
  uid?: number
  gid?: number
  isDirectory?: boolean
  isFile?: boolean
  isSymbolicLink?: boolean
}

export interface SFTPListDirResult {
  path: string
  entries: SFTPFileEntry[]
  totalCount: number
  directoriesCount: number
  filesCount: number
}

export interface SCPResult {
  direction: "upload" | "download" | "remote_to_remote"
  sourcePath: string
  destPath: string
  isDirectory: boolean
  filesCount: number
  directoriesCount: number
  totalBytes: number
  sizeFormatted: string
  durationMs: number
  sourceSession?: string
  targetSession?: string
  message: string
}
