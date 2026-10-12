import { parseSshConfigFile, formatProfileList, getHelpText } from "./ssh-helper.js"

// Track active SSH tool calls for live UI feedback
let activeSshTool = null
let activeSshHost = null
let lastExecutionTime = null

export function register(on) {
  // 1. Session start: Register custom slash commands
  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "ssh-profiles",
      description: "List configured SSH hosts and connection details from ~/.ssh/config",
    })

    await $.command.register({
      name: "ssh-status",
      description: "Show active SSH tool status and recent connection history",
    })

    await $.command.register({
      name: "ssh-help",
      description: "Show SSH tools cheatsheet and available commands",
    })

    return next(e)
  })

  // 2. Command run: /ssh-profiles
  on("command.run", { command: "ssh-profiles" }, async ($, e) => {
    try {
      const home = $.env.get("HOME") || $.env.get("USERPROFILE") || ""
      const configPath = home ? `${home}/.ssh/config` : ""
      let configContent = ""

      if (configPath && (await $.fs.exists(configPath))) {
        configContent = await $.fs.read(configPath)
      }

      const profiles = parseSshConfigFile(configContent)
      return { text: formatProfileList(profiles, configPath) }
    } catch (err) {
      return { text: `Failed to inspect SSH profiles: ${err?.message || String(err)}` }
    }
  })

  // 3. Command run: /ssh-status
  on("command.run", { command: "ssh-status" }, async ($, e) => {
    const lines = [
      "### SSH Tool & Connection Status",
      "",
      activeSshTool
        ? `• **Currently Active Operation**: \`${activeSshTool}\`${activeSshHost ? ` on \`${activeSshHost}\`` : ""}`
        : "• **Currently Active Operation**: None (idle)",
      lastExecutionTime
        ? `• **Last Operation**: completed at ${new Date(lastExecutionTime).toLocaleTimeString()}`
        : "• **Last Operation**: None recorded this session",
      "",
      "_Ask Claude to list sessions, connect, or execute remote commands anytime._",
    ]
    return { text: lines.join("\n") }
  })

  // 4. Command run: /ssh-help
  on("command.run", { command: "ssh-help" }, async () => {
    return { text: getHelpText() }
  })

  // 5. Tool call hook: Observe SSH tool calls and track active remote operation
  on("tool.call", async ($, e, next) => {
    const toolName = e.tool || ""
    if (typeof toolName === "string" && toolName.startsWith("ssh_")) {
      activeSshTool = toolName
      const args = e.input || e.parameters || {}
      activeSshHost = args.host || args.sessionID || args.profile || null
      $.ui.invalidate("ui.render")
    }
    return next(e)
  })

  // 6. Turn complete: Clear active spinner status and timestamp operation
  on("turn.complete", async ($, e, next) => {
    if (activeSshTool) {
      lastExecutionTime = Date.now()
      activeSshTool = null
      activeSshHost = null
      $.ui.invalidate("ui.render")
    }
    return next(e)
  })

  // 7. UI Spinner hook: Display active remote operation alongside the Claude Code spinner
  on("ui.render", { component: "Spinner" }, async ($, e, next) => {
    if (activeSshTool) {
      const target = activeSshHost ? ` (${activeSshHost})` : ""
      return next({
        ...e,
        props: {
          ...e.props,
          suffix: ` · SSH: ${activeSshTool}${target}…`,
        },
      })
    }
    return next(e)
  })
}
