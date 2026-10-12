import { Plugin } from "@opencode/plugin"
import { SessionManager } from "./session-manager.js"
import { ConfigManager } from "./config.js"
import { createSSHTools } from "./tools.js"

export default Plugin.define({
  id: "opencode-ssh",
  async setup(ctx) {
    const configManager = new ConfigManager()
    const sessionManager = new SessionManager(configManager)
    const tools = createSSHTools(sessionManager, configManager)

    // Register SSH tools under "ssh" namespace for clear agent discovery and Code Mode support
    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "ssh",
        description: "Interactive persistent SSH sessions, profiles, SFTP file management, and background jobs",
      })

      for (const tool of tools) {
        editor.add({
          name: tool.name,
          description: tool.description,
          input: tool.input,
          options: { namespace: "ssh", codemode: true },
          execute: tool.execute,
        })
      }
    })

    // Return cleanup callback when plugin unloads
    return async () => {
      await sessionManager.closeAll()
    }
  },
})
