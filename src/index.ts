import { Plugin } from "@opencode/plugin"
import { SessionManager } from "./session-manager.js"
import { ConfigManager } from "./config.js"

export default Plugin.define({
  id: "opencode-ssh",
  async setup(ctx) {
    const configManager = new ConfigManager()
    const sessionManager = new SessionManager(configManager)

    // Register SSH tools under "ssh" namespace for clear agent discovery and Code Mode support
    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "ssh",
        description: "Interactive persistent SSH sessions, profiles, and remote command execution",
      })

      // 1. ssh_list_profiles
      editor.add({
        name: "ssh_list_profiles",
        description:
          "List all available SSH profiles configured in ~/.ssh/config or saved in OpenCode.",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async () => {
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
          return {
            content: JSON.stringify(sanitized, null, 2),
          }
        },
      })

      // 2. ssh_save_profile
      editor.add({
        name: "ssh_save_profile",
        description:
          "Save or update an SSH connection profile with host, user, port, and authentication credentials.",
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
          return {
            content: `Profile '${p.name}' saved successfully.`,
          }
        },
      })

      // 3. ssh_connect
      editor.add({
        name: "ssh_connect",
        description:
          "Open or verify an active SSH session using an existing profile name or direct connection details. Reuses existing session without reauthing.",
        input: {
          type: "object",
          properties: {
            sessionID: {
              type: "string",
              description:
                "Optional session ID. If not provided, defaults to profile name or 'default'.",
            },
            profile: {
              type: "string",
              description: "Name of the profile (from ~/.ssh/config or saved profiles)",
            },
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

            return {
              content: JSON.stringify(
                {
                  status: "connected",
                  session: session.getInfo(),
                },
                null,
                2
              ),
            }
          } catch (err: any) {
            return {
              content: `Failed to connect SSH session: ${err.message || String(err)}`,
            }
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
          return {
            content: JSON.stringify(sessions, null, 2),
          }
        },
      })

      // 5. ssh_exec
      editor.add({
        name: "ssh_exec",
        description:
          "Execute a single remote command over SSH multiplexing (fast, non-interactive) and return stdout, stderr, and exit code. Automatically reuses active authenticated session.",
        input: {
          type: "object",
          properties: {
            command: { type: "string", description: "The shell command to run on the remote machine" },
            sessionID: {
              type: "string",
              description:
                "Target session ID or profile name. If omitted, uses the default or only open session.",
            },
            timeoutMs: {
              type: "number",
              description: "Execution timeout in milliseconds (default: 60000 ms)",
            },
          },
          required: ["command"],
          additionalProperties: false,
        },
        options: { namespace: "ssh", codemode: true },
        execute: async (input, context) => {
          const { command, sessionID, timeoutMs } = input as any
          let session = sessionManager.getSession(sessionID)

          if (!session || !session.isOpen()) {
            await context.progress({ status: `Session not found or closed. Reconnecting...` })
            try {
              session = await sessionManager.getOrCreateSession(sessionID)
            } catch (err: any) {
              return {
                content: `Could not connect to session '${sessionID || "default"}': ${err.message}`,
              }
            }
          }

          await context.progress({ status: `Running: ${command.slice(0, 50)}...` })

          try {
            const res = await session.exec(command, timeoutMs || 60000)
            return {
              content: JSON.stringify(res, null, 2),
            }
          } catch (err: any) {
            return {
              content: `Command execution error: ${err.message || String(err)}`,
            }
          }
        },
      })

      // 6. ssh_interactive_cmd
      editor.add({
        name: "ssh_interactive_cmd",
        description:
          "Run a command inside a persistent PTY shell and wait for completion. Perfect for interactive scripts, environment persistence across commands (e.g. cd, export, venv activation), or REPLs.",
        input: {
          type: "object",
          properties: {
            command: { type: "string", description: "Command to execute inside the persistent shell" },
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
            await context.progress({ status: `Establishing SSH connection...` })
            try {
              session = await sessionManager.getOrCreateSession(sessionID)
            } catch (err: any) {
              return {
                content: `Could not connect SSH session: ${err.message}`,
              }
            }
          }

          await context.progress({ status: `Executing in PTY: ${command.slice(0, 40)}...` })

          try {
            const output = await session.runInPty(command, timeoutMs || 30000)
            return {
              content: output || "(No output)",
            }
          } catch (err: any) {
            return {
              content: `PTY execution failed: ${err.message || String(err)}`,
            }
          }
        },
      })

      // 7. ssh_pty_send
      editor.add({
        name: "ssh_pty_send",
        description:
          "Send raw input or keystrokes (like answering confirmation prompts, entering passwords, or Ctrl+C) to the ongoing PTY session.",
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
            return {
              content: `Session '${sessionID || "default"}' is not open.`,
            }
          }
          if (!session.hasPty()) {
            return {
              content: `Session '${sessionID || "default"}' has no active PTY shell. Call ssh_interactive_cmd first.`,
            }
          }

          session.writePty(text)
          // Wait briefly to allow remote process to digest and output
          await new Promise((r) => setTimeout(r, 400))
          const recent = session.getRecentOutput(50)
          return {
            content: `Input sent.\nRecent PTY output:\n${recent}`,
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
            return {
              content: `Session '${sessionID || "default"}' is not open.`,
            }
          }

          const output = session.getRecentOutput(lines || 100)
          return {
            content: output || "(Buffer empty)",
          }
        },
      })

      // 9. ssh_close
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
          return {
            content: closed
              ? `Session '${sessionID}' closed.`
              : `Session '${sessionID}' was not found or already closed.`,
          }
        },
      })
    })

    // Return cleanup when plugin unloads
    return async () => {
      await sessionManager.closeAll()
    }
  },
})
