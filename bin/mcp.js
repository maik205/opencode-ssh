#!/usr/bin/env node
import { runMcpServer } from "../dist/mcp.js"

runMcpServer().catch((err) => {
  process.stderr.write(`[oc-ssh] Fatal MCP server error: ${err?.stack || err}\n`)
  process.exit(1)
})
