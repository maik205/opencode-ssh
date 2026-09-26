import path from "node:path"
import { Plugin } from "@opencode/plugin"
import { SessionManager } from "./session-manager.js"
import { ConfigManager } from "./config.js"
import { errorResult, successResult } from "./agent-response.js"
import { formatBytes } from "./sftp-manager.js"
import {
  normalizeCommand,
  normalizePath,
  truncateOutput,
  DEFAULT_MAX_OUTPUT_CHARS,
} from "./string-utils.js"

export default Plugin.define({
  id: "opencode-ssh",
  async setup(ctx) {
    const configManager = new ConfigManager()
    const sessionManager = new SessionManager(configManager)

    // Register SSH tools under "ssh" namespace for clear agent discovery and Code Mode support
    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "ssh",
        description: "Interactive persistent SSH sessions, profiles, SFTP file management, and background jobs",
      })

      // 1. ssh_list_profiles
      editor.add({
        name: "ssh_list_profiles",
        description: "List configured SSH profiles from ~/.ssh/config and OpenCode storage.",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async () => {
          try {
            const profiles = await configManager.list()
            const sanitized = profiles.map((p) => ({
              name: p.name,
              host: p.host,
              port: p.port,
              username: p.username,
              privateKeyPath: p.privateKeyPath,
              hasPassword: Boolean(p.password),
              description: p.description,
            }))
            return successResult({ profiles: sanitized, count: sanitized.length })
          } catch (err: any) {
            return errorResult("LIST_PROFILES_FAILED", err.message, "Verify your ~/.ssh/config file permissions.")
          }
        },
      })

      // 2. ssh_save_profile
      editor.add({
        name: "ssh_save_profile",
        description: "Save or update an SSH connection profile.",
        input: {
          type: "object",
          properties: {
            name: { type: "string", description: "Profile identifier (e.g. 'prod', 'staging')" },
            host: { type: "string", description: "Hostname or IP address" },
            port: { type: "number", description: "SSH port (default: 22)" },
            username: { type: "string", description: "Remote username" },
            privateKeyPath: { type: "string", description: "Path to private key file" },
            password: { type: "string", description: "SSH password" },
            passphrase: { type: "string", description: "Private key passphrase" },
            description: { type: "string", description: "Profile notes" },
          },
          required: ["name", "host"],
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async (input) => {
          try {
            const p = input as any
            await configManager.save({
              name: p.name?.trim(),
              host: p.host?.trim(),
              port: p.port || 22,
              username: p.username?.trim(),
              privateKeyPath: p.privateKeyPath ? normalizePath(p.privateKeyPath) : undefined,
              password: p.password,
              passphrase: p.passphrase,
              description: p.description?.trim(),
            })
            return successResult({ message: `Profile '${p.name?.trim()}' saved successfully.`, profile: p.name?.trim() })
          } catch (err: any) {
            return errorResult("SAVE_PROFILE_FAILED", err.message, "Ensure storage directory is writable.")
          }
        },
      })

      // 3. ssh_connect
      editor.add({
        name: "ssh_connect",
        description: "Open or verify active SSH session by profile or host details.",
        input: {
          type: "object",
          properties: {
            sessionID: { type: "string", description: "Session ID (defaults to profile name or 'default')" },
            profile: { type: "string", description: "Profile name from ~/.ssh/config or saved profiles" },
            host: { type: "string", description: "Hostname or IP" },
            port: { type: "number", description: "SSH port (default 22)" },
            username: { type: "string", description: "Remote username" },
            password: { type: "string", description: "Remote password" },
            privateKeyPath: { type: "string", description: "Path to private key" },
            passphrase: { type: "string", description: "Key passphrase if encrypted" },
          },
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async (input, context) => {
          const p = input as any
          const targetSessionId = p.sessionID?.trim() || p.profile?.trim() || "default"

          await context.progress({ status: `Connecting to SSH ${p.host || p.profile || targetSessionId}...` })

          try {
            const session = await sessionManager.getOrCreateSession(targetSessionId, {
              host: p.host?.trim(),
              port: p.port,
              username: p.username?.trim(),
              password: p.password,
              privateKeyPath: p.privateKeyPath ? normalizePath(p.privateKeyPath) : undefined,
              passphrase: p.passphrase,
            })

            return successResult({
              status: "connected",
              session: session.getInfo(),
            })
          } catch (err: any) {
            const isEncryptedKey =
              err.message?.includes("encrypted") ||
              err.message?.includes("passphrase") ||
              err.level === "client-authentication"
            const hint = isEncryptedKey
              ? "Key may be encrypted with a passphrase. Provide 'passphrase' in input or save it with ssh_save_profile."
              : "Check privateKeyPath, username, or pass a password if required."

            return errorResult("SSH_AUTH_FAILED", err.message || String(err), hint)
          }
        },
      })

      // 4. ssh_list_sessions
      editor.add({
        name: "ssh_list_sessions",
        description: "List currently connected active SSH sessions and their status.",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async () => {
          const sessions = sessionManager.listSessions()
          const defaultSession = sessionManager.getDefaultSessionId()
          return successResult({ sessions, defaultSession, count: sessions.length })
        },
      })

      // 5. ssh_exec
      editor.add({
        name: "ssh_exec",
        description: "Run remote shell command via SSH; returns stdout, stderr, exit code.",
        input: {
          type: "object",
          properties: {
            command: { type: "string", description: "Shell command to run on remote host" },
            sessionID: { type: "string", description: "Session ID or profile name (optional)" },
            timeoutMs: { type: "number", description: "Execution timeout in ms (default: 60000)" },
            maxOutputChars: { type: "number", description: "Max characters before truncating (default: 30000)" },
          },
          required: ["command"],
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async (input, context) => {
          const { command, sessionID, timeoutMs, maxOutputChars } = input as any
          const normCmd = normalizeCommand(command)
          if (!normCmd) {
            return errorResult("EMPTY_COMMAND", "Command cannot be empty or whitespace only.")
          }

          let session = sessionManager.getSession(sessionID?.trim())

          if (!session || !session.isOpen()) {
            try {
              session = await sessionManager.getOrCreateSession(sessionID?.trim())
            } catch (err: any) {
              return errorResult(
                "SESSION_CONNECT_FAILED",
                `Could not connect to session '${sessionID || "default"}': ${err.message}`,
                "Call ssh_connect with explicit host/key or use an existing profile name."
              )
            }
          }

          await context.progress({ status: `Running: ${normCmd.slice(0, 45)}...` })

          try {
            const res = await session.exec(normCmd, timeoutMs || 60000)
            const maxChars = typeof maxOutputChars === "number" && maxOutputChars > 0 ? maxOutputChars : DEFAULT_MAX_OUTPUT_CHARS
            const truncStdout = truncateOutput(res.stdout, maxChars)
            const truncStderr = res.stderr ? truncateOutput(res.stderr, maxChars) : undefined

            const resultPayload: Record<string, any> = {
              stdout: truncStdout.text,
              exitCode: res.exitCode,
            }
            if (truncStdout.truncated) {
              resultPayload.stdoutTruncated = true
              resultPayload.totalLines = truncStdout.originalLines
              resultPayload.totalBytes = truncStdout.originalBytes
            }
            if (truncStderr && truncStderr.text) {
              resultPayload.stderr = truncStderr.text
              if (truncStderr.truncated) {
                resultPayload.stderrTruncated = true
              }
            }
            if (res.signal) {
              resultPayload.signal = res.signal
            }
            resultPayload.durationMs = res.durationMs
            resultPayload.executedAs = res.executedAs

            return successResult(resultPayload)
          } catch (err: any) {
            return errorResult(
              "EXEC_FAILED",
              err.message || String(err),
              "Command may have timed out or remote process crashed. Use ssh_job_spawn for long-running commands."
            )
          }
        },
      })

      // 6. ssh_interactive_cmd
      editor.add({
        name: "ssh_interactive_cmd",
        description: "Run command in persistent PTY shell (preserves cd, exports, env).",
        input: {
          type: "object",
          properties: {
            command: { type: "string", description: "Command to execute inside persistent shell" },
            sessionID: { type: "string", description: "Session ID or profile name (optional)" },
            timeoutMs: { type: "number", description: "Timeout in ms to wait for output (default: 30000)" },
            maxOutputChars: { type: "number", description: "Max characters before truncating (default: 30000)" },
          },
          required: ["command"],
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async (input, context) => {
          const { command, sessionID, timeoutMs, maxOutputChars } = input as any
          const normCmd = normalizeCommand(command)
          if (!normCmd) {
            return errorResult("EMPTY_COMMAND", "Command cannot be empty or whitespace only.")
          }

          let session = sessionManager.getSession(sessionID?.trim())

          if (!session || !session.isOpen()) {
            try {
              session = await sessionManager.getOrCreateSession(sessionID?.trim())
            } catch (err: any) {
              return errorResult(
                "SESSION_CONNECT_FAILED",
                `Could not connect SSH session: ${err.message}`,
                "Ensure target session or profile exists."
              )
            }
          }

          await context.progress({ status: `Executing in PTY: ${normCmd.slice(0, 40)}...` })

          try {
            const rawOutput = await session.runInPty(normCmd, timeoutMs || 30000)
            const maxChars = typeof maxOutputChars === "number" && maxOutputChars > 0 ? maxOutputChars : DEFAULT_MAX_OUTPUT_CHARS
            const trunc = truncateOutput(rawOutput, maxChars)

            const resultPayload: Record<string, any> = {
              output: trunc.text,
              executedAs: session.currentPtyUser || session.username,
            }
            if (trunc.truncated) {
              resultPayload.outputTruncated = true
              resultPayload.totalLines = trunc.originalLines
              resultPayload.totalBytes = trunc.originalBytes
            }

            return successResult(resultPayload)
          } catch (err: any) {
            return errorResult("PTY_EXEC_FAILED", err.message || String(err))
          }
        },
      })

      // 7. ssh_pty_send
      editor.add({
        name: "ssh_pty_send",
        description: "Send raw input or keystrokes (passwords, confirmation answers, Ctrl+C) to ongoing PTY.",
        input: {
          type: "object",
          properties: {
            input: { type: "string", description: "Text or control sequence to send (e.g. 'yes\\n', '\\x03' for SIGINT)" },
            sessionID: { type: "string", description: "Session ID or profile name (optional)" },
          },
          required: ["input"],
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async (input) => {
          const { input: rawInput, sessionID } = input as any
          const session = sessionManager.getSession(sessionID?.trim())
          if (!session || !session.isOpen()) {
            return errorResult("SESSION_NOT_OPEN", `Session '${sessionID || "default"}' is not open.`)
          }
          if (!session.hasPty()) {
            return errorResult("NO_ACTIVE_PTY", "No active PTY shell found. Call ssh_interactive_cmd first.")
          }

          const text = typeof rawInput === "string" ? rawInput.replace(/\r\n/g, "\n") : ""
          session.writePty(text)
          await new Promise((r) => setTimeout(r, 400))
          const recent = session.getRecentOutput(50)
          return successResult({ message: "Input sent", recentOutput: recent })
        },
      })

      // 8. ssh_switch_user
      editor.add({
        name: "ssh_switch_user",
        description: "Switch user (e.g. to root) in persistent PTY shell using sudo/su.",
        input: {
          type: "object",
          properties: {
            user: { type: "string", description: "Target username to switch to (default: 'root')" },
            password: { type: "string", description: "User or sudo password if prompted" },
            sessionID: { type: "string", description: "Session ID or profile name (optional)" },
            timeoutMs: { type: "number", description: "Timeout in ms for the switch operation (default: 8000)" },
          },
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async (input, context) => {
          const { user = "root", password, sessionID, timeoutMs } = input as any
          const targetUser = user?.trim() || "root"
          let session = sessionManager.getSession(sessionID?.trim())
          if (!session || !session.isOpen()) {
            session = await sessionManager.getOrCreateSession(sessionID?.trim())
          }

          await context.progress({ status: `Switching to user '${targetUser}' on ${session.host}...` })

          try {
            const result = await session.switchUserInPty(targetUser, password, timeoutMs || 8000)
            if (result.success) {
              return successResult({
                user: result.user,
                host: session.host,
                message: `Successfully switched to user '${result.user}'. Subsequent ssh_interactive_cmd calls will execute as this user.`,
                output: result.output,
              })
            } else {
              return errorResult(
                "USER_SWITCH_FAILED",
                `Failed to switch to user '${targetUser}'. Current user is still '${result.user}'.`,
                result.output.toLowerCase().includes("password")
                  ? "Password was incorrect or required. Pass the 'password' parameter."
                  : "Check user permissions or sudoers configuration on remote host."
              )
            }
          } catch (err: any) {
            return errorResult("USER_SWITCH_ERROR", err.message || String(err))
          }
        },
      })

      // 9. ssh_pty_read
      editor.add({
        name: "ssh_pty_read",
        description: "Read recent terminal buffer lines from interactive PTY.",
        input: {
          type: "object",
          properties: {
            sessionID: { type: "string", description: "Session ID or profile name (optional)" },
            lines: { type: "number", description: "Number of lines to read (default: 100)" },
          },
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async (input) => {
          const { sessionID, lines } = input as any
          const session = sessionManager.getSession(sessionID?.trim())
          if (!session || !session.isOpen()) {
            return errorResult("SESSION_NOT_OPEN", `Session '${sessionID || "default"}' is not open.`)
          }

          const output = session.getRecentOutput(lines || 100)
          return successResult({ output: output || "(Buffer empty)" })
        },
      })

      // === SFTP Remote File Operations ===

      // 10. ssh_read_file
      editor.add({
        name: "ssh_read_file",
        description: "Read remote file over SFTP with pagination and line numbering.",
        input: {
          type: "object",
          properties: {
            path: { type: "string", description: "Remote file path" },
            sessionID: { type: "string", description: "Session ID or profile name (optional)" },
            offset: { type: "number", description: "1-based line number to start reading from (default: 1)" },
            limit: { type: "number", description: "Maximum lines to read (default: 2000)" },
          },
          required: ["path"],
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async (input, context) => {
          const { path: filePath, sessionID, offset, limit } = input as any
          const cleanPath = normalizePath(filePath)
          let session = sessionManager.getSession(sessionID?.trim())
          if (!session || !session.isOpen()) {
            session = await sessionManager.getOrCreateSession(sessionID?.trim())
          }

          await context.progress({ status: `Reading remote file: ${cleanPath}...` })
          try {
            const res = await session.sftp.readFile(cleanPath, offset || 1, limit || 2000)
            return successResult({
              path: cleanPath,
              totalLines: res.totalLines,
              offset: offset || 1,
              hasMore: res.hasMore,
              content: res.content,
            })
          } catch (err: any) {
            return errorResult(
              "FILE_READ_FAILED",
              err.message || String(err),
              "Verify the file path and that the remote user has read permissions."
            )
          }
        },
      })

      // 11. ssh_write_file
      editor.add({
        name: "ssh_write_file",
        description: "Write or overwrite a file on the remote machine over SFTP.",
        input: {
          type: "object",
          properties: {
            path: { type: "string", description: "Remote file path to write to" },
            content: { type: "string", description: "Complete content to write to the remote file" },
            sessionID: { type: "string", description: "Session ID or profile name (optional)" },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async (input, context) => {
          const { path: filePath, content, sessionID } = input as any
          const cleanPath = normalizePath(filePath)
          let session = sessionManager.getSession(sessionID?.trim())
          if (!session || !session.isOpen()) {
            session = await sessionManager.getOrCreateSession(sessionID?.trim())
          }

          await context.progress({ status: `Writing remote file: ${cleanPath}...` })
          try {
            await session.sftp.writeFile(cleanPath, content)
            return successResult({
              path: cleanPath,
              bytesWritten: Buffer.byteLength(content, "utf-8"),
              message: `Successfully wrote file: ${cleanPath}`,
            })
          } catch (err: any) {
            return errorResult(
              "FILE_WRITE_FAILED",
              err.message || String(err),
              "Ensure parent directory exists and remote user has write permissions."
            )
          }
        },
      })

      // 12. ssh_edit_file
      editor.add({
        name: "ssh_edit_file",
        description: "Find and replace exact text in a remote file over SFTP.",
        input: {
          type: "object",
          properties: {
            path: { type: "string", description: "Remote file path to edit" },
            oldString: { type: "string", description: "Exact text to find and replace" },
            newString: { type: "string", description: "Text to replace oldString with (must differ)" },
            replaceAll: {
              type: "boolean",
              description: "Whether to replace every occurrence (default: false, requiring single match)",
            },
            sessionID: { type: "string", description: "Session ID or profile name (optional)" },
          },
          required: ["path", "oldString", "newString"],
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async (input, context) => {
          const { path: filePath, oldString, newString, replaceAll, sessionID } = input as any
          const cleanPath = normalizePath(filePath)
          let session = sessionManager.getSession(sessionID?.trim())
          if (!session || !session.isOpen()) {
            session = await sessionManager.getOrCreateSession(sessionID?.trim())
          }

          await context.progress({ status: `Editing remote file: ${cleanPath}...` })
          try {
            const res = await session.sftp.editFile(cleanPath, oldString, newString, replaceAll || false)
            return successResult({
              path: cleanPath,
              replacements: res.replacements,
              totalLines: res.totalLines,
              message: `Successfully edited ${cleanPath}`,
            })
          } catch (err: any) {
            return errorResult(
              "FILE_EDIT_FAILED",
              err.message || String(err),
              "Ensure oldString matches remote content including whitespace, or set replaceAll to true."
            )
          }
        },
      })

      // 13. ssh_scp
      editor.add({
        name: "ssh_scp",
        description: "Securely copy files or directories between local machine and remote host, or directly between two remote sessions.",
        input: {
          type: "object",
          properties: {
            direction: {
              type: "string",
              enum: ["upload", "download", "remote_to_remote"],
              description: "Transfer direction: 'upload', 'download', or 'remote_to_remote'",
            },
            sourcePath: {
              type: "string",
              description: "Source path of file or directory",
            },
            destPath: {
              type: "string",
              description: "Destination path of file or directory",
            },
            recursive: {
              type: "boolean",
              description: "Transfer directories recursively (default: false)",
            },
            sessionID: {
              type: "string",
              description: "Session ID (source session if remote_to_remote)",
            },
            targetSessionID: {
              type: "string",
              description: "Destination session ID (for remote_to_remote)",
            },
            concurrency: {
              type: "number",
              description: "Concurrent chunk transfers (default: 4)",
            },
          },
          required: ["direction", "sourcePath", "destPath"],
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async (input, context) => {
          const {
            direction,
            sourcePath: rawSource,
            destPath: rawDest,
            recursive = false,
            sessionID,
            targetSessionID,
            concurrency = 4,
          } = input as any

          const sourcePath = typeof rawSource === "string" ? rawSource.trim() : rawSource
          const destPath = typeof rawDest === "string" ? rawDest.trim() : rawDest

          const startTime = Date.now()
          const dirLower = String(direction).toLowerCase().trim()

          // Progress throttling
          let lastProgressUpdate = 0
          const onProgress = (file: string, transferredBytes: number, totalBytes?: number) => {
            const now = Date.now()
            if (now - lastProgressUpdate > 500) {
              lastProgressUpdate = now
              const pct =
                totalBytes && totalBytes > 0
                  ? ` (${Math.round((transferredBytes / totalBytes) * 100)}%)`
                  : ""
              context
                .progress({
                  status: `[SCP] Transferring ${file}: ${formatBytes(transferredBytes)}${
                    totalBytes ? ` / ${formatBytes(totalBytes)}` : ""
                  }${pct}`,
                })
                .catch(() => {})
            }
          }

          try {
            if (dirLower === "upload" || dirLower === "local_to_remote" || dirLower === "to_remote") {
              const { resolveLocalPath } = await import("./sftp-manager.js")
              const resolvedLocal = resolveLocalPath(sourcePath)
              const fs = await import("node:fs")

              if (!fs.existsSync(resolvedLocal)) {
                return errorResult("SCP_UPLOAD_FAILED", `Local path '${sourcePath}' does not exist.`)
              }

              const localStat = fs.statSync(resolvedLocal)
              const isDir = localStat.isDirectory()

              if (isDir && !recursive) {
                return errorResult(
                  "SCP_DIRECTORY_REQUIRES_RECURSIVE",
                  `Local path '${sourcePath}' is a directory. Set recursive: true to transfer directories.`
                )
              }

              let session = sessionManager.getSession(sessionID?.trim())
              if (!session || !session.isOpen()) {
                session = await sessionManager.getOrCreateSession(sessionID?.trim())
              }

              await context.progress({
                status: `[SCP] Uploading ${sourcePath} to ${session.host}:${destPath}...`,
              })

              if (isDir) {
                const res = await session.sftp.uploadDir(sourcePath, destPath, {
                  concurrency,
                  onProgress,
                })
                return successResult({
                  direction: "upload",
                  sourcePath,
                  destPath,
                  isDirectory: true,
                  filesCount: res.filesCount,
                  directoriesCount: res.directoriesCount,
                  totalBytes: res.totalBytes,
                  sizeFormatted: formatBytes(res.totalBytes),
                  durationMs: Date.now() - startTime,
                  message: `Successfully uploaded directory '${sourcePath}' (${res.filesCount} files, ${formatBytes(
                    res.totalBytes
                  )}) to '${destPath}'.`,
                })
              } else {
                const res = await session.sftp.fastPut(sourcePath, destPath, {
                  concurrency,
                  onProgress: (transferred, total) =>
                    onProgress(path.basename(sourcePath), transferred, total),
                })
                return successResult({
                  direction: "upload",
                  sourcePath,
                  destPath: res.remotePath,
                  isDirectory: false,
                  filesCount: 1,
                  directoriesCount: 0,
                  totalBytes: res.bytes,
                  sizeFormatted: formatBytes(res.bytes),
                  durationMs: Date.now() - startTime,
                  message: `Successfully uploaded '${sourcePath}' (${formatBytes(res.bytes)}) to '${res.remotePath}'.`,
                })
              }
            } else if (
              dirLower === "download" ||
              dirLower === "remote_to_local" ||
              dirLower === "from_remote"
            ) {
              let session = sessionManager.getSession(sessionID?.trim())
              if (!session || !session.isOpen()) {
                session = await sessionManager.getOrCreateSession(sessionID?.trim())
              }

              const remoteStat = await session.sftp.stat(sourcePath)
              if (!remoteStat.exists) {
                return errorResult(
                  "SCP_DOWNLOAD_FAILED",
                  `Remote path '${sourcePath}' does not exist on ${session.host}.`
                )
              }

              const isDir = remoteStat.isDirectory ?? false
              if (isDir && !recursive) {
                return errorResult(
                  "SCP_DIRECTORY_REQUIRES_RECURSIVE",
                  `Remote path '${sourcePath}' is a directory. Set recursive: true to transfer directories.`
                )
              }

              await context.progress({
                status: `[SCP] Downloading ${session.host}:${sourcePath} to ${destPath}...`,
              })

              if (isDir) {
                const res = await session.sftp.downloadDir(sourcePath, destPath, {
                  concurrency,
                  onProgress,
                })
                return successResult({
                  direction: "download",
                  sourcePath,
                  destPath,
                  isDirectory: true,
                  filesCount: res.filesCount,
                  directoriesCount: res.directoriesCount,
                  totalBytes: res.totalBytes,
                  sizeFormatted: formatBytes(res.totalBytes),
                  durationMs: Date.now() - startTime,
                  message: `Successfully downloaded directory '${sourcePath}' (${res.filesCount} files, ${formatBytes(
                    res.totalBytes
                  )}) to '${destPath}'.`,
                })
              } else {
                const res = await session.sftp.fastGet(sourcePath, destPath, {
                  concurrency,
                  onProgress: (transferred, total) =>
                    onProgress(path.posix.basename(sourcePath), transferred, total),
                })
                return successResult({
                  direction: "download",
                  sourcePath,
                  destPath: res.localPath,
                  isDirectory: false,
                  filesCount: 1,
                  directoriesCount: 0,
                  totalBytes: res.bytes,
                  sizeFormatted: formatBytes(res.bytes),
                  durationMs: Date.now() - startTime,
                  message: `Successfully downloaded '${sourcePath}' (${formatBytes(res.bytes)}) to '${res.localPath}'.`,
                })
              }
            } else if (dirLower === "remote_to_remote") {
              if (!targetSessionID) {
                return errorResult(
                  "MISSING_TARGET_SESSION",
                  "targetSessionID is required when direction is 'remote_to_remote'."
                )
              }

              let sourceSession = sessionManager.getSession(sessionID?.trim())
              if (!sourceSession || !sourceSession.isOpen()) {
                sourceSession = await sessionManager.getOrCreateSession(sessionID?.trim())
              }

              let targetSession = sessionManager.getSession(targetSessionID?.trim())
              if (!targetSession || !targetSession.isOpen()) {
                targetSession = await sessionManager.getOrCreateSession(targetSessionID?.trim())
              }

              await context.progress({
                status: `[SCP] Streaming ${sourceSession.host}:${sourcePath} to ${targetSession.host}:${destPath}...`,
              })

              const res = await sourceSession.sftp.copyToRemote(sourcePath, targetSession.sftp, destPath, {
                recursive,
                onProgress: (file, transferred) => onProgress(file, transferred),
              })

              return successResult({
                direction: "remote_to_remote",
                sourceSession: sourceSession.id,
                targetSession: targetSession.id,
                sourcePath,
                destPath,
                isDirectory: res.isDirectory,
                filesCount: res.filesCount,
                directoriesCount: res.directoriesCount,
                totalBytes: res.totalBytes,
                sizeFormatted: formatBytes(res.totalBytes),
                durationMs: Date.now() - startTime,
                message: `Successfully transferred ${res.isDirectory ? "directory" : "file"} from '${
                  sourceSession.id
                }:${sourcePath}' to '${targetSession.id}:${destPath}' (${formatBytes(res.totalBytes)}).`,
              })
            } else {
              return errorResult(
                "INVALID_DIRECTION",
                `Invalid transfer direction '${direction}'. Allowed values: 'upload', 'download', 'remote_to_remote'.`
              )
            }
          } catch (err: any) {
            return errorResult("SCP_FAILED", err.message || String(err))
          }
        },
      })

      // 14. ssh_list_dir
      editor.add({
        name: "ssh_list_dir",
        description: "List remote directory contents with size, permissions, and timestamps.",
        input: {
          type: "object",
          properties: {
            path: { type: "string", description: "Remote directory path to list (default: '.')" },
            showHidden: { type: "boolean", description: "Include hidden files/directories (default: true)" },
            sort: {
              type: "string",
              enum: ["name", "size", "mtime"],
              description: "Sort order: 'name', 'size', or 'mtime'",
            },
            details: {
              type: "boolean",
              description: "Include extended attributes like mode, uid, gid (default: false for token efficiency)",
            },
            sessionID: { type: "string", description: "Session ID or profile name (optional)" },
          },
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async (input, context) => {
          const { path: dirPath, showHidden, sort, details, sessionID } = input as any
          const cleanPath = dirPath ? normalizePath(dirPath) : "."
          let session = sessionManager.getSession(sessionID?.trim())
          if (!session || !session.isOpen()) {
            session = await sessionManager.getOrCreateSession(sessionID?.trim())
          }

          await context.progress({ status: `Listing remote directory: ${cleanPath}...` })
          try {
            const res = await session.sftp.listDir(cleanPath, showHidden ?? true, sort || "name")
            if (!details) {
              const compactEntries = res.entries.map((e) => ({
                name: e.name,
                type: e.type,
                size: e.sizeFormatted,
                permissions: e.permissions,
                mtime: e.mtime,
                ...(e.isSymbolicLink && (e as any).target ? { target: (e as any).target } : {}),
              }))
              return successResult({
                path: res.path,
                totalCount: res.totalCount,
                directoriesCount: res.directoriesCount,
                filesCount: res.filesCount,
                entries: compactEntries,
              })
            }
            return successResult(res)
          } catch (err: any) {
            return errorResult(
              "LIST_DIR_FAILED",
              err.message || String(err),
              "Verify the directory path exists and the remote user has read permissions."
            )
          }
        },
      })

      // 15. ssh_stat
      editor.add({
        name: "ssh_stat",
        description: "Inspect remote file, directory, or symlink attributes and existence.",
        input: {
          type: "object",
          properties: {
            path: { type: "string", description: "Remote file or directory path to inspect" },
            sessionID: { type: "string", description: "Session ID or profile name (optional)" },
          },
          required: ["path"],
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async (input, context) => {
          const { path: filePath, sessionID } = input as any
          const cleanPath = normalizePath(filePath)
          let session = sessionManager.getSession(sessionID?.trim())
          if (!session || !session.isOpen()) {
            session = await sessionManager.getOrCreateSession(sessionID?.trim())
          }

          await context.progress({ status: `Checking attributes: ${cleanPath}...` })
          try {
            const res = await session.sftp.stat(cleanPath)
            return successResult(res)
          } catch (err: any) {
            return errorResult("STAT_FAILED", err.message || String(err))
          }
        },
      })

      // 16. ssh_mkdir
      editor.add({
        name: "ssh_mkdir",
        description: "Create remote directory (mkdir -p by default).",
        input: {
          type: "object",
          properties: {
            path: { type: "string", description: "Remote directory path to create" },
            recursive: {
              type: "boolean",
              description: "Create parent directories as needed (default: true)",
            },
            sessionID: { type: "string", description: "Session ID or profile name (optional)" },
          },
          required: ["path"],
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async (input, context) => {
          const { path: dirPath, recursive, sessionID } = input as any
          const cleanPath = normalizePath(dirPath)
          let session = sessionManager.getSession(sessionID?.trim())
          if (!session || !session.isOpen()) {
            session = await sessionManager.getOrCreateSession(sessionID?.trim())
          }

          await context.progress({ status: `Creating remote directory: ${cleanPath}...` })
          try {
            await session.sftp.mkdir(cleanPath, recursive ?? true)
            return successResult({
              path: cleanPath,
              created: true,
              message: `Directory '${cleanPath}' created successfully.`,
            })
          } catch (err: any) {
            return errorResult(
              "MKDIR_FAILED",
              err.message || String(err),
              "Ensure parent directory exists or set recursive to true."
            )
          }
        },
      })

      // 17. ssh_rm
      editor.add({
        name: "ssh_rm",
        description: "Delete a file or directory on the remote machine over SFTP.",
        input: {
          type: "object",
          properties: {
            path: { type: "string", description: "Remote file or directory path to delete" },
            recursive: {
              type: "boolean",
              description: "Recursively delete directories and all their contents (default: false)",
            },
            sessionID: { type: "string", description: "Session ID or profile name (optional)" },
          },
          required: ["path"],
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async (input, context) => {
          const { path: filePath, recursive, sessionID } = input as any
          const cleanPath = normalizePath(filePath)
          let session = sessionManager.getSession(sessionID?.trim())
          if (!session || !session.isOpen()) {
            session = await sessionManager.getOrCreateSession(sessionID?.trim())
          }

          await context.progress({ status: `Deleting remote path: ${cleanPath}...` })
          try {
            const res = await session.sftp.rm(cleanPath, recursive ?? false)
            return successResult({
              path: cleanPath,
              deleted: true,
              isDirectory: res.isDirectory,
              message: `Successfully removed ${res.isDirectory ? "directory" : "file"}: ${cleanPath}`,
            })
          } catch (err: any) {
            return errorResult(
              "RM_FAILED",
              err.message || String(err),
              "If deleting a non-empty directory, set recursive: true."
            )
          }
        },
      })

      // 18. ssh_rename
      editor.add({
        name: "ssh_rename",
        description: "Move or rename a file or directory on the remote machine over SFTP.",
        input: {
          type: "object",
          properties: {
            oldPath: { type: "string", description: "Current remote file or directory path" },
            newPath: { type: "string", description: "Destination remote file or directory path" },
            sessionID: { type: "string", description: "Session ID or profile name (optional)" },
          },
          required: ["oldPath", "newPath"],
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async (input, context) => {
          const { oldPath, newPath, sessionID } = input as any
          const cleanOld = normalizePath(oldPath)
          const cleanNew = normalizePath(newPath)
          let session = sessionManager.getSession(sessionID?.trim())
          if (!session || !session.isOpen()) {
            session = await sessionManager.getOrCreateSession(sessionID?.trim())
          }

          await context.progress({ status: `Renaming '${cleanOld}' to '${cleanNew}'...` })
          try {
            await session.sftp.rename(cleanOld, cleanNew)
            return successResult({
              oldPath: cleanOld,
              newPath: cleanNew,
              renamed: true,
              message: `Successfully moved/renamed '${cleanOld}' to '${cleanNew}'.`,
            })
          } catch (err: any) {
            return errorResult(
              "RENAME_FAILED",
              err.message || String(err),
              "Ensure destination directory exists and remote user has write permissions."
            )
          }
        },
      })

      // 19. ssh_chmod
      editor.add({
        name: "ssh_chmod",
        description: "Change permissions/mode of a remote file or directory over SFTP (e.g. '0755', '0644').",
        input: {
          type: "object",
          properties: {
            path: { type: "string", description: "Remote file or directory path" },
            mode: { type: "string", description: "Octal permissions string (e.g. '755', '0755', '644')" },
            sessionID: { type: "string", description: "Session ID or profile name (optional)" },
          },
          required: ["path", "mode"],
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async (input, context) => {
          const { path: filePath, mode, sessionID } = input as any
          const cleanPath = normalizePath(filePath)
          const cleanMode = typeof mode === "string" ? mode.trim() : mode
          let session = sessionManager.getSession(sessionID?.trim())
          if (!session || !session.isOpen()) {
            session = await sessionManager.getOrCreateSession(sessionID?.trim())
          }

          await context.progress({ status: `Setting mode ${cleanMode} on: ${cleanPath}...` })
          try {
            const appliedMode = await session.sftp.chmod(cleanPath, cleanMode)
            return successResult({
              path: cleanPath,
              mode: appliedMode,
              message: `Successfully changed permissions of '${cleanPath}' to ${appliedMode}.`,
            })
          } catch (err: any) {
            return errorResult("CHMOD_FAILED", err.message || String(err))
          }
        },
      })

      // === Background Jobs & System Inspection ===

      // 20. ssh_system_inspect
      editor.add({
        name: "ssh_system_inspect",
        description: "Probe remote system: OS, CPU, RAM, disk, runtimes, listening ports, git status.",
        input: {
          type: "object",
          properties: {
            sessionID: { type: "string", description: "Session ID or profile name (optional)" },
          },
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async (input, context) => {
          const { sessionID } = input as any
          let session = sessionManager.getSession(sessionID?.trim())
          if (!session || !session.isOpen()) {
            session = await sessionManager.getOrCreateSession(sessionID?.trim())
          }

          await context.progress({ status: `Inspecting remote system on ${session.host}...` })
          try {
            const { inspectSystem } = await import("./system-inspector.js")
            const report = await inspectSystem(session)
            return successResult(report)
          } catch (err: any) {
            return errorResult("INSPECT_FAILED", err.message || String(err))
          }
        },
      })

      // 21. ssh_job_spawn
      editor.add({
        name: "ssh_job_spawn",
        description: "Spawn a detached, supervised background command on the remote machine.",
        input: {
          type: "object",
          properties: {
            command: { type: "string", description: "Command to execute in background" },
            sessionID: { type: "string", description: "Session ID or profile name (optional)" },
          },
          required: ["command"],
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async (input, context) => {
          const { command, sessionID } = input as any
          const normCmd = normalizeCommand(command)
          if (!normCmd) {
            return errorResult("EMPTY_COMMAND", "Command cannot be empty or whitespace only.")
          }

          let session = sessionManager.getSession(sessionID?.trim())
          if (!session || !session.isOpen()) {
            session = await sessionManager.getOrCreateSession(sessionID?.trim())
          }

          await context.progress({ status: `Spawning background job: ${normCmd.slice(0, 30)}...` })
          try {
            const job = await session.jobs.spawnJob(normCmd)
            return successResult({ job, message: `Job ${job.id} started in background.` })
          } catch (err: any) {
            return errorResult("JOB_SPAWN_FAILED", err.message || String(err))
          }
        },
      })

      // 22. ssh_job_status
      editor.add({
        name: "ssh_job_status",
        description: "Check status and exit code of a background job.",
        input: {
          type: "object",
          properties: {
            jobID: { type: "string", description: "The job identifier" },
            sessionID: { type: "string", description: "Session ID or profile name (optional)" },
          },
          required: ["jobID"],
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async (input) => {
          const { jobID, sessionID } = input as any
          const cleanJobId = typeof jobID === "string" ? jobID.trim() : jobID
          const session = sessionManager.getSession(sessionID?.trim())
          if (!session || !session.isOpen()) {
            return errorResult("SESSION_NOT_OPEN", `Session '${sessionID || "default"}' is not open.`)
          }

          try {
            const status = await session.jobs.getJobStatus(cleanJobId)
            return successResult({ job: status })
          } catch (err: any) {
            return errorResult("JOB_STATUS_FAILED", err.message || String(err))
          }
        },
      })

      // 23. ssh_job_logs
      editor.add({
        name: "ssh_job_logs",
        description: "Retrieve stdout/stderr logs from a background job.",
        input: {
          type: "object",
          properties: {
            jobID: { type: "string", description: "The job identifier" },
            lines: { type: "number", description: "Number of tail lines to retrieve (default: 100)" },
            sessionID: { type: "string", description: "Session ID or profile name (optional)" },
          },
          required: ["jobID"],
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async (input) => {
          const { jobID, lines, sessionID } = input as any
          const cleanJobId = typeof jobID === "string" ? jobID.trim() : jobID
          const session = sessionManager.getSession(sessionID?.trim())
          if (!session || !session.isOpen()) {
            return errorResult("SESSION_NOT_OPEN", `Session '${sessionID || "default"}' is not open.`)
          }

          try {
            const res = await session.jobs.getJobLogs(cleanJobId, lines || 100)
            const trunc = truncateOutput(res.logs)
            return successResult({
              jobID: cleanJobId,
              isRunning: res.isRunning,
              logs: trunc.text,
              ...(trunc.truncated ? { logsTruncated: true } : {}),
            })
          } catch (err: any) {
            return errorResult("JOB_LOGS_FAILED", err.message || String(err))
          }
        },
      })

      // 24. ssh_job_kill
      editor.add({
        name: "ssh_job_kill",
        description: "Terminate a background job with SIGTERM, SIGINT, or SIGKILL.",
        input: {
          type: "object",
          properties: {
            jobID: { type: "string", description: "The job identifier" },
            signal: {
              type: "string",
              enum: ["SIGINT", "SIGTERM", "SIGKILL"],
              description: "Signal to send (default: SIGTERM)",
            },
            sessionID: { type: "string", description: "Session ID or profile name (optional)" },
          },
          required: ["jobID"],
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async (input) => {
          const { jobID, signal, sessionID } = input as any
          const cleanJobId = typeof jobID === "string" ? jobID.trim() : jobID
          const session = sessionManager.getSession(sessionID?.trim())
          if (!session || !session.isOpen()) {
            return errorResult("SESSION_NOT_OPEN", `Session '${sessionID || "default"}' is not open.`)
          }

          try {
            const killed = await session.jobs.killJob(cleanJobId, signal || "SIGTERM")
            return successResult({
              jobID: cleanJobId,
              killed,
              message: killed ? `Job was terminated with ${signal || "SIGTERM"}.` : "Could not terminate job.",
            })
          } catch (err: any) {
            return errorResult("JOB_KILL_FAILED", err.message || String(err))
          }
        },
      })

      // === Multi-Session & Cluster Management ===

      // 25. ssh_switch_session
      editor.add({
        name: "ssh_switch_session",
        description: "Switch the active/default SSH session so subsequent commands default to this host.",
        input: {
          type: "object",
          properties: {
            sessionID: { type: "string", description: "Session ID or profile name to make active default" },
          },
          required: ["sessionID"],
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async (input) => {
          const { sessionID } = input as any
          const cleanId = typeof sessionID === "string" ? sessionID.trim() : sessionID
          let session = sessionManager.getSession(cleanId)
          if (!session || !session.isOpen()) {
            session = await sessionManager.getOrCreateSession(cleanId)
          }

          sessionManager.setDefaultSession(session.id)
          return successResult({
            activeSession: session.id,
            host: session.host,
            message: `Switched default active session to '${session.id}'.`,
          })
        },
      })

      // 26. ssh_broadcast
      editor.add({
        name: "ssh_broadcast",
        description: "Execute a command concurrently across multiple or all connected SSH sessions.",
        input: {
          type: "object",
          properties: {
            command: { type: "string", description: "Command to execute across sessions" },
            targets: {
              type: "array",
              items: { type: "string" },
              description: "Array of session IDs or profiles (omitted = all open sessions)",
            },
            timeoutMs: { type: "number", description: "Timeout per host in ms (default: 60000)" },
          },
          required: ["command"],
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async (input, context) => {
          const { command, targets, timeoutMs } = input as any
          const normCmd = normalizeCommand(command)
          if (!normCmd) {
            return errorResult("EMPTY_COMMAND", "Command cannot be empty or whitespace only.")
          }

          await context.progress({ status: `Broadcasting command to target sessions...` })

          try {
            const { broadcastCommand } = await import("./cluster.js")
            const res = await broadcastCommand(
              sessionManager,
              Array.isArray(targets) && targets.length > 0 ? targets : "all",
              normCmd,
              timeoutMs || 60000
            )
            return successResult(res)
          } catch (err: any) {
            return errorResult("BROADCAST_FAILED", err.message || String(err))
          }
        },
      })

      // 27. ssh_close
      editor.add({
        name: "ssh_close",
        description: "Disconnect and close an active SSH session, freeing remote resources.",
        input: {
          type: "object",
          properties: {
            sessionID: { type: "string", description: "Session ID to close" },
          },
          required: ["sessionID"],
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async (input) => {
          const { sessionID } = input as any
          const cleanId = typeof sessionID === "string" ? sessionID.trim() : sessionID
          const closed = await sessionManager.closeSession(cleanId)
          return successResult({
            sessionID: cleanId,
            closed,
            message: closed ? `Session '${cleanId}' closed.` : `Session was not found or already closed.`,
          })
        },
      })
    })

    // Return cleanup when plugin unloads
    return async () => {
      await sessionManager.closeAll()
    }
  },
})
