import { describe, it, expect, vi } from "vitest"
import { register } from "../hooks/register.js"
import {
  parseSshConfigFile,
  formatProfileList,
  getHelpText,
} from "../hooks/ssh-helper.js"

describe("Claude Code Mod: SSH Helper", () => {
  it("parses SSH config files correctly", () => {
    const config = `
# Global default
Host *
  ServerAliveInterval 60

Host prod-server
  HostName 192.168.1.100
  User ubuntu
  Port 2222
  IdentityFile ~/.ssh/id_ed25519

Host staging
  HostName staging.internal
  User dev
`

    const profiles = parseSshConfigFile(config)
    expect(profiles.length).toBe(2)

    expect(profiles[0].name).toBe("prod-server")
    expect(profiles[0].hostName).toBe("192.168.1.100")
    expect(profiles[0].user).toBe("ubuntu")
    expect(profiles[0].port).toBe(2222)
    expect(profiles[0].identityFile).toBe("~/.ssh/id_ed25519")

    expect(profiles[1].name).toBe("staging")
    expect(profiles[1].hostName).toBe("staging.internal")
    expect(profiles[1].user).toBe("dev")
    expect(profiles[1].port).toBe(22)
  })

  it("formats profile list into markdown", () => {
    const profiles = [
      { name: "prod", hostName: "prod.example.com", user: "root", port: 22 },
      { name: "db", hostName: "10.0.0.5", user: "postgres", port: 5432, identityFile: "~/.ssh/db.pem" },
    ]

    const text = formatProfileList(profiles, "/home/user/.ssh/config")
    expect(text).toContain("Configured SSH Profiles (2)")
    expect(text).toContain("**`prod`** -> `root@prod.example.com`")
    expect(text).toContain("**`db`** -> `postgres@10.0.0.5:5432`")
    expect(text).toContain("key: `~/.ssh/db.pem`")
  })

  it("handles empty config gracefully", () => {
    const text = formatProfileList([], "/home/user/.ssh/config")
    expect(text).toContain("No specific host configurations found")
  })

  it("provides help cheatsheet text", () => {
    const help = getHelpText()
    expect(help).toContain("/ssh-profiles")
    expect(help).toContain("/ssh-status")
    expect(help).toContain("ssh_connect")
    expect(help).toContain("ssh_exec")
    expect(help).toContain("ssh_scp")
  })
})

describe("Claude Code Mod: register() Lifecycle & Hooks", () => {
  it("registers all required hooks and slash commands", async () => {
    const registeredHooks: Record<string, Array<{ matcher?: any; fn: Function }>> = {}

    const on = (event: string, ...args: any[]) => {
      if (!registeredHooks[event]) registeredHooks[event] = []
      if (args.length === 1) {
        registeredHooks[event].push({ fn: args[0] })
      } else {
        registeredHooks[event].push({ matcher: args[0], fn: args[1] })
      }
    }

    register(on)

    expect(registeredHooks["session.start"]).toBeDefined()
    expect(registeredHooks["command.run"]).toBeDefined()
    expect(registeredHooks["tool.call"]).toBeDefined()
    expect(registeredHooks["turn.complete"]).toBeDefined()
    expect(registeredHooks["ui.render"]).toBeDefined()

    // Test session.start
    const registeredCommands: any[] = []
    const mock$ = {
      command: {
        register: vi.fn(async (cmd) => {
          registeredCommands.push(cmd)
        }),
      },
      env: {
        get: vi.fn((key) => (key === "HOME" ? "/mock/home" : "")),
      },
      fs: {
        exists: vi.fn(async () => true),
        read: vi.fn(async () => "Host testbox\n  HostName 1.2.3.4\n  User admin\n"),
      },
      ui: {
        invalidate: vi.fn(),
      },
    }

    const sessionStartHook = registeredHooks["session.start"][0].fn
    const nextMock = vi.fn((e) => e)
    await sessionStartHook(mock$, { sessionId: "s1" }, nextMock)

    expect(mock$.command.register).toHaveBeenCalledTimes(3)
    const cmdNames = registeredCommands.map((c) => c.name)
    expect(cmdNames).toContain("ssh-profiles")
    expect(cmdNames).toContain("ssh-status")
    expect(cmdNames).toContain("ssh-help")
    expect(nextMock).toHaveBeenCalled()

    // Test /ssh-profiles command
    const profilesHook = registeredHooks["command.run"].find(
      (h) => h.matcher?.command === "ssh-profiles"
    )?.fn
    expect(profilesHook).toBeDefined()
    const profilesResult = await profilesHook(mock$, {})
    expect(profilesResult.text).toContain("Configured SSH Profiles")
    expect(profilesResult.text).toContain("testbox")

    // Test /ssh-help command
    const helpHook = registeredHooks["command.run"].find(
      (h) => h.matcher?.command === "ssh-help"
    )?.fn
    expect(helpHook).toBeDefined()
    const helpResult = await helpHook(mock$, {})
    expect(helpResult.text).toContain("SSH Tools & Claude Code Mod Cheatsheet")

    // Test tool.call hook when calling ssh_exec
    const toolCallHook = registeredHooks["tool.call"][0].fn
    await toolCallHook(mock$, { tool: "ssh_exec", input: { host: "prod-db" } }, nextMock)
    expect(mock$.ui.invalidate).toHaveBeenCalledWith("ui.render")

    // Test /ssh-status command while tool is active
    const statusHook = registeredHooks["command.run"].find(
      (h) => h.matcher?.command === "ssh-status"
    )?.fn
    expect(statusHook).toBeDefined()
    const statusResult = await statusHook(mock$, {})
    expect(statusResult.text).toContain("Currently Active Operation")
    expect(statusResult.text).toContain("ssh_exec")
    expect(statusResult.text).toContain("prod-db")

    // Test ui.render Spinner hook
    const spinnerHook = registeredHooks["ui.render"].find(
      (h) => h.matcher?.component === "Spinner"
    )?.fn
    expect(spinnerHook).toBeDefined()
    const spinnerRenderResult = await spinnerHook(
      mock$,
      { props: { message: "Running" } },
      (e: any) => e
    )
    expect(spinnerRenderResult.props.suffix).toContain("SSH: ssh_exec (prod-db)")

    // Test turn.complete resets active operation
    const turnCompleteHook = registeredHooks["turn.complete"][0].fn
    await turnCompleteHook(mock$, {}, nextMock)

    // Spinner after turn complete
    const idleSpinnerResult = await spinnerHook(
      mock$,
      { props: { message: "Thinking" } },
      (e: any) => e
    )
    expect(idleSpinnerResult.props.suffix).toBeUndefined()
  })
})
