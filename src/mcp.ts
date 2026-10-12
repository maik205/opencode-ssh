import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { SessionManager } from "./session-manager.js"
import { ConfigManager } from "./config.js"
import { createSSHTools, type SSHPluginTool } from "./tools.js"

export interface McpServerInstance {
  server: Server
  sessionManager: SessionManager
  configManager: ConfigManager
  tools: SSHPluginTool[]
}

/**
 * Creates and configures the SSH MCP Server instance.
 */
export function createMcpServer(): McpServerInstance {
  const configManager = new ConfigManager()
  const sessionManager = new SessionManager(configManager)
  const tools = createSSHTools(sessionManager, configManager)
  const toolMap = new Map(tools.map((t) => [t.name, t]))

  const server = new Server(
    {
      name: "opencode-ssh",
      version: "0.2.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  )

  // 1. List tools handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.input,
      })),
    }
  })

  // 2. Call tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params
    const tool = toolMap.get(name)

    if (!tool) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              error: {
                code: "UNKNOWN_TOOL",
                message: `Tool '${name}' not found. Use list_tools to see available tools.`,
              },
            }),
          },
        ],
        isError: true,
      }
    }

    try {
      const res = await tool.execute(args || {}, {
        progress: (p) => {
          // Write progress updates to stderr so stdio JSON-RPC transport on stdout remains pristine
          process.stderr.write(`[oc-ssh:${name}] ${p.status}\n`)
        },
      })

      let isError = false
      try {
        const parsed = JSON.parse(res.content)
        if (parsed && parsed.success === false) {
          isError = true
        }
      } catch {}

      return {
        content: [
          {
            type: "text",
            text: res.content,
          },
        ],
        isError,
      }
    } catch (err: any) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              error: {
                code: "TOOL_EXECUTION_ERROR",
                message: err.message || String(err),
              },
            }),
          },
        ],
        isError: true,
      }
    }
  })

  return { server, sessionManager, configManager, tools }
}

/**
 * Runs the SSH MCP Server over Stdio transport.
 */
export async function runMcpServer(): Promise<void> {
  // Check CLI arguments for help / version
  const args = process.argv.slice(2)
  if (args.includes("--help") || args.includes("-h")) {
    process.stderr.write(`
opencode-plugin-ssh: Model Context Protocol (MCP) Server for SSH & SFTP

Usage:
  npx opencode-plugin-ssh [options]
  opencode-ssh-mcp [options]

Options:
  --help, -h       Show this help message
  --version, -v    Show version

Claude Code setup:
  claude mcp add ssh -- npx -y opencode-plugin-ssh

Project .mcp.json setup:
  {
    "mcpServers": {
      "ssh": {
        "command": "npx",
        "args": ["-y", "opencode-plugin-ssh"]
      }
    }
  }
\n`)
    process.exit(0)
  }

  if (args.includes("--version") || args.includes("-v")) {
    process.stderr.write("0.2.0\n")
    process.exit(0)
  }

  const { server, sessionManager } = createMcpServer()
  const transport = new StdioServerTransport()

  // Graceful shutdown
  const cleanup = async () => {
    try {
      await sessionManager.closeAll()
    } catch {}
    process.exit(0)
  }

  process.on("SIGINT", cleanup)
  process.on("SIGTERM", cleanup)

  await server.connect(transport)
  process.stderr.write("[oc-ssh] SSH MCP server connected and listening via stdio\n")
}
