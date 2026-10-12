import { describe, it, expect, vi } from "vitest"
import { createMcpServer } from "../src/mcp.js"
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"

describe("SSH MCP Server", () => {
  it("initializes MCP server and registers all 27 tools", async () => {
    const { server, tools } = createMcpServer()
    expect(tools.length).toBe(27)

    // Verify list tools handler
    const listHandler = (server as any)._requestHandlers.get(
      ListToolsRequestSchema.shape.method.value
    )
    expect(listHandler).toBeDefined()

    const listResult = await listHandler({ method: "tools/list", params: {} }, {})
    expect(listResult.tools).toBeDefined()
    expect(listResult.tools.length).toBe(27)

    const toolNames = listResult.tools.map((t: any) => t.name)
    expect(toolNames).toContain("ssh_list_profiles")
    expect(toolNames).toContain("ssh_connect")
    expect(toolNames).toContain("ssh_exec")
    expect(toolNames).toContain("ssh_interactive_cmd")
    expect(toolNames).toContain("ssh_read_file")
    expect(toolNames).toContain("ssh_write_file")
    expect(toolNames).toContain("ssh_edit_file")
    expect(toolNames).toContain("ssh_scp")
    expect(toolNames).toContain("ssh_list_dir")
    expect(toolNames).toContain("ssh_system_inspect")
    expect(toolNames).toContain("ssh_job_spawn")
    expect(toolNames).toContain("ssh_broadcast")
  })

  it("handles tools/call for ssh_list_profiles", async () => {
    const { server } = createMcpServer()
    const callHandler = (server as any)._requestHandlers.get(
      CallToolRequestSchema.shape.method.value
    )
    expect(callHandler).toBeDefined()

    const result = await callHandler(
      {
        method: "tools/call",
        params: {
          name: "ssh_list_profiles",
          arguments: {},
        },
      },
      {}
    )

    expect(result).toBeDefined()
    expect(result.content).toBeDefined()
    expect(result.content.length).toBe(1)
    expect(result.content[0].type).toBe("text")

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.success).toBe(true)
    expect(Array.isArray(parsed.profiles)).toBe(true)
    expect(result.isError).toBe(false)
  })

  it("returns error result for unknown tool", async () => {
    const { server } = createMcpServer()
    const callHandler = (server as any)._requestHandlers.get(
      CallToolRequestSchema.shape.method.value
    )

    const result = await callHandler(
      {
        method: "tools/call",
        params: {
          name: "nonexistent_tool",
          arguments: {},
        },
      },
      {}
    )

    expect(result.isError).toBe(true)
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.success).toBe(false)
    expect(parsed.error.code).toBe("UNKNOWN_TOOL")
  })

  it("handles progress callback without breaking stdio output", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const { server } = createMcpServer()
    const callHandler = (server as any)._requestHandlers.get(
      CallToolRequestSchema.shape.method.value
    )

    // Call ssh_exec with empty command -> returns EMPTY_COMMAND error
    const result = await callHandler(
      {
        method: "tools/call",
        params: {
          name: "ssh_exec",
          arguments: { command: "   " },
        },
      },
      {}
    )

    expect(result.isError).toBe(true)
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.error.code).toBe("EMPTY_COMMAND")
    stderrSpy.mockRestore()
  })
})
