import path from "node:path"
import { Plugin } from "@opencode/plugin"
import { SessionManager } from "./session-manager.js"
import { ConfigManager } from "./config.js"
import { errorResult, successResult } from "./agent-response.js"
import { formatBytes } from "./sftp-manager.js"

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
        description: "List all available SSH profiles configured in ~/.ssh/config or saved in OpenCode.",
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
        description: "Save or update an SSH connection profile with host, user, port, and authentication credentials.",
        input: {
          type: "object",
          properties: {
            name: { type: "string", description: "Profile identifier name (e.g. 'prod-server', 'staging')" },
            host: { type: "string", description: "Hostname or IP address" },
            port: { type: "number", description: "SSH port (default: 22)" },
            username: { type: "string", description: "Remote username" },
            privateKeyPath: { type: "string", description: "Path to SSH private key file" },
            password: { type: "string", description: "SSH password (optional)" },
            passphrase: { type: "string", description: "Passphrase for encrypted private key (optional)" },
            description: { type: "string", description: "Optional notes about this profile" },
          },
          required: ["name", "host"],
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async (input) => {
          try {
            const p = input as any
            await configManager.save({
              name: p.name,
              host: p.host,
              port: p.port || 22,
              username: p.username,
              privateKeyPath: p.privateKeyPath,
              password: p.password,
              passphrase: p.passphrase,
              description: p.description,
            })
            return successResult({ message: `Profile '${p.name}' saved successfully.`, profile: p.name })
          } catch (err: any) {
            return errorResult("SAVE_PROFILE_FAILED", err.message, "Ensure storage directory is writable.")
          }
        },
      })

      // 3. ssh_connect
      editor.add({
        name: "ssh_connect",
        description: "Open or verify an active SSH session using an existing profile name or direct connection details. Reuses existing session without reauthing.",
        input: {
          type: "object",
          properties: {
            sessionID: { type: "string", description: "Optional session ID. If not provided, defaults to profile name or 'default'." },
            profile: { type: "string", description: "Name of the profile (from ~/.ssh/config or saved profiles)" },
            host: { type: "string", description: "Direct hostname or IP" },
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
          const targetSessionId = p.sessionID || p.profile || "default"

          await context.progress({ status: `Connecting to SSH ${p.host || p.profile || targetSessionId}...` })

          try {
            const session = await sessionManager.getOrCreateSession(targetSessionId, {
              host: p.host,
              port: p.port,
              username: p.username,
              password: p.password,
              privateKeyPath: p.privateKeyPath,
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
        description: "Execute a single remote command over SSH multiplexing (fast, non-interactive) and return stdout, stderr, and exit code. Automatically reuses active authenticated session.",
        input: {
          type: "object",
          properties: {
            command: { type: "string", description: "The shell command to run on the remote machine" },
            sessionID: { type: "string", description: "Target session ID or profile name (optional)" },
            timeoutMs: { type: "number", description: "Execution timeout in milliseconds (default: 60000 ms)" },
          },
          required: ["command"],
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async (input, context) => {
          const { command, sessionID, timeoutMs } = input as any
          let session = sessionManager.getSession(sessionID)

          if (!session || !session.isOpen()) {
            try {
              session = await sessionManager.getOrCreateSession(sessionID)
            } catch (err: any) {
              return errorResult(
                "SESSION_CONNECT_FAILED",
                `Could not connect to session '${sessionID || "default"}': ${err.message}`,
                "Call ssh_connect with explicit host/key or use an existing profile name."
              )
            }
          }

          await context.progress({ status: `Running: ${command.slice(0, 45)}...` })

          try {
            const res = await session.exec(command, timeoutMs || 60000)
            return successResult({
              command,
              ...res,
            })
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
        description: "Run a command inside a persistent PTY shell with environment/state preservation across calls (cd, export, virtualenvs).",
        input: {
          type: "object",
          properties: {
            command: { type: "string", description: "Command to execute inside persistent shell" },
            sessionID: { type: "string", description: "Session ID or profile name (optional)" },
            timeoutMs: { type: "number", description: "Timeout in ms to wait for output (default 30000)" },
          },
          required: ["command"],
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async (input, context) => {
          const { command, sessionID, timeoutMs } = input as any
          let session = sessionManager.getSession(sessionID)

          if (!session || !session.isOpen()) {
            try {
              session = await sessionManager.getOrCreateSession(sessionID)
            } catch (err: any) {
              return errorResult(
                "SESSION_CONNECT_FAILED",
                `Could not connect SSH session: ${err.message}`,
                "Ensure target session or profile exists."
              )
            }
          }

          await context.progress({ status: `Executing in PTY: ${command.slice(0, 40)}...` })

          try {
            const output = await session.runInPty(command, timeoutMs || 30000)
            return successResult({
              command,
              output,
              executedAs: session.currentPtyUser || session.username,
            })
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
          const { input: text, sessionID } = input as any
          const session = sessionManager.getSession(sessionID)
          if (!session || !session.isOpen()) {
            return errorResult("SESSION_NOT_OPEN", `Session '${sessionID || "default"}' is not open.`)
          }
          if (!session.hasPty()) {
            return errorResult("NO_ACTIVE_PTY", "No active PTY shell found. Call ssh_interactive_cmd first.")
          }

          session.writePty(text)
          await new Promise((r) => setTimeout(r, 400))
          const recent = session.getRecentOutput(50)
          return successResult({ message: "Input sent", recentOutput: recent })
        },
      })

      // 8. ssh_switch_user
      editor.add({
        name: "ssh_switch_user",
        description: "Switch user (e.g. to 'root' or another system account) in the persistent remote shell using sudo/su. Can accept sudo password if required.",
        input: {
          type: "object",
          properties: {
            user: { type: "string", description: "Target username to switch to (default: 'root')" },
            password: { type: "string", description: "User password or sudo password if prompted" },
            sessionID: { type: "string", description: "Session ID or profile name (optional)" },
            timeoutMs: { type: "number", description: "Timeout in ms for the switch operation (default 8000)" },
          },
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async (input, context) => {
          const { user = "root", password, sessionID, timeoutMs } = input as any
          let session = sessionManager.getSession(sessionID)
          if (!session || !session.isOpen()) {
            session = await sessionManager.getOrCreateSession(sessionID)
          }

          await context.progress({ status: `Switching to user '${user}' on ${session.host}...` })

          try {
            const result = await session.switchUserInPty(user, password, timeoutMs || 8000)
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
                `Failed to switch to user '${user}'. Current user is still '${result.user}'.`,
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

      // 8. ssh_pty_read
      editor.add({
        name: "ssh_pty_read",
        description: "Read the most recent terminal buffer lines from the interactive PTY shell.",
        input: {
          type: "object",
          properties: {
            sessionID: { type: "string", description: "Session ID or profile name (optional)" },
            lines: { type: "number", description: "Number of lines to read (default 100)" },
          },
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async (input) => {
          const { sessionID, lines } = input as any
          const session = sessionManager.getSession(sessionID)
          if (!session || !session.isOpen()) {
            return errorResult("SESSION_NOT_OPEN", `Session '${sessionID || "default"}' is not open.`)
          }

          const output = session.getRecentOutput(lines || 100)
          return successResult({ output: output || "(Buffer empty)" })
        },
      })

      // === SFTP Remote File Operations ===

      // 9. ssh_read_file
      editor.add({
        name: "ssh_read_file",
        description: "Read remote file content over SFTP with line numbers, offset, and limit support.",
        input: {
          type: "object",
          properties: {
            path: { type: "string", description: "Remote absolute or relative file path" },
            sessionID: { type: "string", description: "Target session ID or profile (optional)" },
            offset: { type: "number", description: "1-based line number to start reading from (default: 1)" },
            limit: { type: "number", description: "Maximum lines to read (default: 2000)" },
          },
          required: ["path"],
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async (input, context) => {
          const { path: filePath, sessionID, offset, limit } = input as any
          let session = sessionManager.getSession(sessionID)
          if (!session || !session.isOpen()) {
            session = await sessionManager.getOrCreateSession(sessionID)
          }

          await context.progress({ status: `Reading remote file: ${filePath}...` })
          try {
            const res = await session.sftp.readFile(filePath, offset || 1, limit || 2000)
            return successResult({
              path: filePath,
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

      // 10. ssh_write_file
      editor.add({
        name: "ssh_write_file",
        description: "Atomically write or overwrite a file on the remote machine over SFTP.",
        input: {
          type: "object",
          properties: {
            path: { type: "string", description: "Remote file path to write to" },
            content: { type: "string", description: "Complete content to write to the remote file" },
            sessionID: { type: "string", description: "Target session ID or profile (optional)" },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async (input, context) => {
          const { path: filePath, content, sessionID } = input as any
          let session = sessionManager.getSession(sessionID)
          if (!session || !session.isOpen()) {
            session = await sessionManager.getOrCreateSession(sessionID)
          }

          await context.progress({ status: `Writing remote file: ${filePath}...` })
          try {
            await session.sftp.writeFile(filePath, content)
            return successResult({
              path: filePath,
              bytesWritten: Buffer.byteLength(content, "utf-8"),
              message: `Successfully wrote file: ${filePath}`,
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

      // 11. ssh_edit_file
      editor.add({
        name: "ssh_edit_file",
        description: "Targeted search-and-replace edit on a remote file over SFTP (mirrors OpenCode's native edit tool).",
        input: {
          type: "object",
          properties: {
            path: { type: "string", description: "Remote file path to edit" },
            oldString: { type: "string", description: "Exact text to find and replace" },
            newString: { type: "string", description: "Text to replace oldString with (must differ)" },
            replaceAll: {
              type: "boolean",
              description: "Whether to replace every occurrence (default: false, requiring exactly one match)",
            },
            sessionID: { type: "string", description: "Target session ID or profile (optional)" },
          },
          required: ["path", "oldString", "newString"],
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async (input, context) => {
          const { path: filePath, oldString, newString, replaceAll, sessionID } = input as any
          let session = sessionManager.getSession(sessionID)
          if (!session || !session.isOpen()) {
            session = await sessionManager.getOrCreateSession(sessionID)
          }

          await context.progress({ status: `Editing remote file: ${filePath}...` })
          try {
            const res = await session.sftp.editFile(filePath, oldString, newString, replaceAll || false)
            return successResult({
              path: filePath,
              replacements: res.replacements,
              totalLines: res.totalLines,
              message: `Successfully edited ${filePath}`,
            })
          } catch (err: any) {
            return errorResult(
              "FILE_EDIT_FAILED",
              err.message || String(err),
              "Ensure oldString matches exact remote content including whitespace, or set replaceAll to true."
            )
          }
        },
      })

      // 12. ssh_scp
      editor.add({
        name: "ssh_scp",
        description: "Securely copy files or directories between local machine and remote host (upload/download), or directly between two remote SSH sessions.",
        input: {
          type: "object",
          properties: {
            direction: {
              type: "string",
              enum: ["upload", "download", "remote_to_remote"],
              description: "Transfer direction: 'upload' (local -> remote), 'download' (remote -> local), or 'remote_to_remote' (session -> targetSession)",
            },
            sourcePath: {
              type: "string",
              description: "Source path of file or directory (local path for upload; remote path for download/remote_to_remote)",
            },
            destPath: {
              type: "string",
              description: "Destination path of file or directory (remote path for upload/remote_to_remote; local path for download)",
            },
            recursive: {
              type: "boolean",
              description: "Transfer directories recursively (default: false)",
            },
            sessionID: {
              type: "string",
              description: "Target session ID or profile (for upload/download), or source session (for remote_to_remote)",
            },
            targetSessionID: {
              type: "string",
              description: "Destination session ID or profile (required only when direction is 'remote_to_remote')",
            },
            concurrency: {
              type: "number",
              description: "Concurrent chunks for high throughput transfers (default: 4)",
            },
          },
          required: ["direction", "sourcePath", "destPath"],
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async (input, context) => {
          const {
            direction,
            sourcePath,
            destPath,
            recursive = false,
            sessionID,
            targetSessionID,
            concurrency = 4,
          } = input as any

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

              let session = sessionManager.getSession(sessionID)
              if (!session || !session.isOpen()) {
                session = await sessionManager.getOrCreateSession(sessionID)
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
              let session = sessionManager.getSession(sessionID)
              if (!session || !session.isOpen()) {
                session = await sessionManager.getOrCreateSession(sessionID)
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

              let sourceSession = sessionManager.getSession(sessionID)
              if (!sourceSession || !sourceSession.isOpen()) {
                sourceSession = await sessionManager.getOrCreateSession(sessionID)
              }

              let targetSession = sessionManager.getSession(targetSessionID)
              if (!targetSession || !targetSession.isOpen()) {
                targetSession = await sessionManager.getOrCreateSession(targetSessionID)
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

      // 13. ssh_list_dir
      editor.add({
        name: "ssh_list_dir",
        description: "List files and directories on the remote machine over SFTP with detailed file metadata (size, permissions, timestamps, type).",
        input: {
          type: "object",
          properties: {
            path: { type: "string", description: "Remote directory path to list (default: current/home directory '.')" },
            showHidden: { type: "boolean", description: "Include hidden files/directories starting with '.' (default: true)" },
            sort: {
              type: "string",
              enum: ["name", "size", "mtime"],
              description: "Sort order: 'name' (default, directories first), 'size' (largest first), or 'mtime' (newest first)",
            },
            sessionID: { type: "string", description: "Target session ID or profile (optional)" },
          },
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async (input, context) => {
          const { path: dirPath, showHidden, sort, sessionID } = input as any
          let session = sessionManager.getSession(sessionID)
          if (!session || !session.isOpen()) {
            session = await sessionManager.getOrCreateSession(sessionID)
          }

          await context.progress({ status: `Listing remote directory: ${dirPath || "."}...` })
          try {
            const res = await session.sftp.listDir(dirPath || ".", showHidden ?? true, sort || "name")
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

      // 14. ssh_stat
      editor.add({
        name: "ssh_stat",
        description: "Inspect attributes and metadata of a remote file, directory, or symlink over SFTP (size, permissions, timestamps, existence).",
        input: {
          type: "object",
          properties: {
            path: { type: "string", description: "Remote file or directory path to inspect" },
            sessionID: { type: "string", description: "Target session ID or profile (optional)" },
          },
          required: ["path"],
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async (input, context) => {
          const { path: filePath, sessionID } = input as any
          let session = sessionManager.getSession(sessionID)
          if (!session || !session.isOpen()) {
            session = await sessionManager.getOrCreateSession(sessionID)
          }

          await context.progress({ status: `Checking attributes for: ${filePath}...` })
          try {
            const res = await session.sftp.stat(filePath)
            return successResult(res)
          } catch (err: any) {
            return errorResult("STAT_FAILED", err.message || String(err))
          }
        },
      })

      // 15. ssh_mkdir
      editor.add({
        name: "ssh_mkdir",
        description: "Create a directory on the remote machine over SFTP with optional recursive creation of parent directories.",
        input: {
          type: "object",
          properties: {
            path: { type: "string", description: "Remote directory path to create" },
            recursive: {
              type: "boolean",
              description: "Create parent directories as needed, like mkdir -p (default: true)",
            },
            sessionID: { type: "string", description: "Target session ID or profile (optional)" },
          },
          required: ["path"],
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async (input, context) => {
          const { path: dirPath, recursive, sessionID } = input as any
          let session = sessionManager.getSession(sessionID)
          if (!session || !session.isOpen()) {
            session = await sessionManager.getOrCreateSession(sessionID)
          }

          await context.progress({ status: `Creating remote directory: ${dirPath}...` })
          try {
            await session.sftp.mkdir(dirPath, recursive ?? true)
            return successResult({
              path: dirPath,
              created: true,
              message: `Directory '${dirPath}' created successfully.`,
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

      // 16. ssh_rm
      editor.add({
        name: "ssh_rm",
        description: "Delete a file or directory on the remote machine over SFTP. Supports recursive removal for non-empty directories.",
        input: {
          type: "object",
          properties: {
            path: { type: "string", description: "Remote file or directory path to delete" },
            recursive: {
              type: "boolean",
              description: "Whether to recursively delete directories and all their contents (default: false)",
            },
            sessionID: { type: "string", description: "Target session ID or profile (optional)" },
          },
          required: ["path"],
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async (input, context) => {
          const { path: filePath, recursive, sessionID } = input as any
          let session = sessionManager.getSession(sessionID)
          if (!session || !session.isOpen()) {
            session = await sessionManager.getOrCreateSession(sessionID)
          }

          await context.progress({ status: `Deleting remote path: ${filePath}...` })
          try {
            const res = await session.sftp.rm(filePath, recursive ?? false)
            return successResult({
              path: filePath,
              deleted: true,
              isDirectory: res.isDirectory,
              message: `Successfully removed ${res.isDirectory ? "directory" : "file"}: ${filePath}`,
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

      // 17. ssh_rename
      editor.add({
        name: "ssh_rename",
        description: "Move or rename a file or directory on the remote machine over SFTP.",
        input: {
          type: "object",
          properties: {
            oldPath: { type: "string", description: "Current remote file or directory path" },
            newPath: { type: "string", description: "Destination remote file or directory path" },
            sessionID: { type: "string", description: "Target session ID or profile (optional)" },
          },
          required: ["oldPath", "newPath"],
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async (input, context) => {
          const { oldPath, newPath, sessionID } = input as any
          let session = sessionManager.getSession(sessionID)
          if (!session || !session.isOpen()) {
            session = await sessionManager.getOrCreateSession(sessionID)
          }

          await context.progress({ status: `Renaming '${oldPath}' to '${newPath}'...` })
          try {
            await session.sftp.rename(oldPath, newPath)
            return successResult({
              oldPath,
              newPath,
              renamed: true,
              message: `Successfully moved/renamed '${oldPath}' to '${newPath}'.`,
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

      // 18. ssh_chmod
      editor.add({
        name: "ssh_chmod",
        description: "Change permissions/mode of a remote file or directory over SFTP (e.g. '0755', '0644', '0600').",
        input: {
          type: "object",
          properties: {
            path: { type: "string", description: "Remote file or directory path" },
            mode: { type: "string", description: "Octal permissions string (e.g. '755', '0755', '644', '600')" },
            sessionID: { type: "string", description: "Target session ID or profile (optional)" },
          },
          required: ["path", "mode"],
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async (input, context) => {
          const { path: filePath, mode, sessionID } = input as any
          let session = sessionManager.getSession(sessionID)
          if (!session || !session.isOpen()) {
            session = await sessionManager.getOrCreateSession(sessionID)
          }

          await context.progress({ status: `Setting mode ${mode} on: ${filePath}...` })
          try {
            const appliedMode = await session.sftp.chmod(filePath, mode)
            return successResult({
              path: filePath,
              mode: appliedMode,
              message: `Successfully changed permissions of '${filePath}' to ${appliedMode}.`,
            })
          } catch (err: any) {
            return errorResult("CHMOD_FAILED", err.message || String(err))
          }
        },
      })

      // === Background Jobs & System Inspection ===

      // 19. ssh_system_inspect
      editor.add({
        name: "ssh_system_inspect",
        description: "Comprehensive remote system health and environment inspect in a single call (OS, CPU, RAM, Disk, package managers, runtimes, listening ports, git status).",
        input: {
          type: "object",
          properties: {
            sessionID: { type: "string", description: "Target session ID or profile (optional)" },
          },
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async (input, context) => {
          const { sessionID } = input as any
          let session = sessionManager.getSession(sessionID)
          if (!session || !session.isOpen()) {
            session = await sessionManager.getOrCreateSession(sessionID)
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

      // 20. ssh_job_spawn
      editor.add({
        name: "ssh_job_spawn",
        description: "Spawn a detached, supervised long-running background command on the remote machine. Returns immediately with a job ID.",
        input: {
          type: "object",
          properties: {
            command: { type: "string", description: "Long running command to execute in background" },
            sessionID: { type: "string", description: "Target session ID or profile (optional)" },
          },
          required: ["command"],
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async (input, context) => {
          const { command, sessionID } = input as any
          let session = sessionManager.getSession(sessionID)
          if (!session || !session.isOpen()) {
            session = await sessionManager.getOrCreateSession(sessionID)
          }

          await context.progress({ status: `Spawning background job: ${command.slice(0, 30)}...` })
          try {
            const job = await session.jobs.spawnJob(command)
            return successResult({ job, message: `Job ${job.id} started in background.` })
          } catch (err: any) {
            return errorResult("JOB_SPAWN_FAILED", err.message || String(err))
          }
        },
      })

      // 21. ssh_job_status
      editor.add({
        name: "ssh_job_status",
        description: "Check status, exit code, and liveness of a background job spawned via ssh_job_spawn.",
        input: {
          type: "object",
          properties: {
            jobID: { type: "string", description: "The job identifier" },
            sessionID: { type: "string", description: "Target session ID or profile (optional)" },
          },
          required: ["jobID"],
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async (input) => {
          const { jobID, sessionID } = input as any
          const session = sessionManager.getSession(sessionID)
          if (!session || !session.isOpen()) {
            return errorResult("SESSION_NOT_OPEN", `Session '${sessionID || "default"}' is not open.`)
          }

          try {
            const status = await session.jobs.getJobStatus(jobID)
            return successResult({ job: status })
          } catch (err: any) {
            return errorResult("JOB_STATUS_FAILED", err.message || String(err))
          }
        },
      })

      // 22. ssh_job_logs
      editor.add({
        name: "ssh_job_logs",
        description: "Retrieve latest stdout/stderr logs from a background job spawned via ssh_job_spawn.",
        input: {
          type: "object",
          properties: {
            jobID: { type: "string", description: "The job identifier" },
            lines: { type: "number", description: "Number of tail lines to retrieve (default: 100)" },
            sessionID: { type: "string", description: "Target session ID or profile (optional)" },
          },
          required: ["jobID"],
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async (input) => {
          const { jobID, lines, sessionID } = input as any
          const session = sessionManager.getSession(sessionID)
          if (!session || !session.isOpen()) {
            return errorResult("SESSION_NOT_OPEN", `Session '${sessionID || "default"}' is not open.`)
          }

          try {
            const res = await session.jobs.getJobLogs(jobID, lines || 100)
            return successResult({
              jobID,
              isRunning: res.isRunning,
              logs: res.logs,
            })
          } catch (err: any) {
            return errorResult("JOB_LOGS_FAILED", err.message || String(err))
          }
        },
      })

      // 23. ssh_job_kill
      editor.add({
        name: "ssh_job_kill",
        description: "Terminate a remote background job with SIGTERM, SIGINT, or SIGKILL.",
        input: {
          type: "object",
          properties: {
            jobID: { type: "string", description: "The job identifier" },
            signal: {
              type: "string",
              enum: ["SIGINT", "SIGTERM", "SIGKILL"],
              description: "Signal to send (default: SIGTERM)",
            },
            sessionID: { type: "string", description: "Target session ID or profile (optional)" },
          },
          required: ["jobID"],
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async (input) => {
          const { jobID, signal, sessionID } = input as any
          const session = sessionManager.getSession(sessionID)
          if (!session || !session.isOpen()) {
            return errorResult("SESSION_NOT_OPEN", `Session '${sessionID || "default"}' is not open.`)
          }

          try {
            const killed = await session.jobs.killJob(jobID, signal || "SIGTERM")
            return successResult({
              jobID,
              killed,
              message: killed ? `Job was terminated with ${signal || "SIGTERM"}.` : "Could not terminate job.",
            })
          } catch (err: any) {
            return errorResult("JOB_KILL_FAILED", err.message || String(err))
          }
        },
      })

      // === Multi-Session & Cluster Management ===

      // 24. ssh_switch_session
      editor.add({
        name: "ssh_switch_session",
        description: "Switch the active/default SSH session so subsequent commands default to this host.",
        input: {
          type: "object",
          properties: {
            sessionID: { type: "string", description: "The session ID or profile to make active default" },
          },
          required: ["sessionID"],
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async (input) => {
          const { sessionID } = input as any
          let session = sessionManager.getSession(sessionID)
          if (!session || !session.isOpen()) {
            session = await sessionManager.getOrCreateSession(sessionID)
          }

          const switched = sessionManager.setDefaultSession(session.id)
          return successResult({
            activeSession: session.id,
            host: session.host,
            message: `Switched default active session to '${session.id}'.`,
          })
        },
      })

      // 25. ssh_broadcast
      editor.add({
        name: "ssh_broadcast",
        description: "Execute a shell command concurrently across multiple or all connected SSH sessions (cluster diagnostics, rolling updates).",
        input: {
          type: "object",
          properties: {
            command: { type: "string", description: "Command to execute across sessions" },
            targets: {
              type: "array",
              items: { type: "string" },
              description: "Array of session IDs or profile names. If omitted or empty, broadcasts to all open sessions.",
            },
            timeoutMs: { type: "number", description: "Timeout per host in ms (default: 60000)" },
          },
          required: ["command"],
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async (input, context) => {
          const { command, targets, timeoutMs } = input as any
          await context.progress({ status: `Broadcasting command to target sessions...` })

          try {
            const { broadcastCommand } = await import("./cluster.js")
            const res = await broadcastCommand(
              sessionManager,
              Array.isArray(targets) && targets.length > 0 ? targets : "all",
              command,
              timeoutMs || 60000
            )
            return successResult(res)
          } catch (err: any) {
            return errorResult("BROADCAST_FAILED", err.message || String(err))
          }
        },
      })

      // 26. ssh_close
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
          const closed = await sessionManager.closeSession(sessionID)
          return successResult({
            sessionID,
            closed,
            message: closed ? `Session '${sessionID}' closed.` : `Session was not found or already closed.`,
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
