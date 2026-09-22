import { Plugin } from "@opencode/plugin"
import { SessionManager } from "./session-manager.js"
import { ConfigManager } from "./config.js"
import { errorResult, successResult } from "./agent-response.js"

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

      // === Background Jobs & System Inspection ===

      // 12. ssh_system_inspect
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

      // 13. ssh_job_spawn
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

      // 14. ssh_job_status
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

      // 15. ssh_job_logs
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

      // 16. ssh_job_kill
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

      // 17. ssh_switch_session
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

      // 18. ssh_broadcast
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

      // 19. ssh_close
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
