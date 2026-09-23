import { describe, it, expect, vi } from "vitest"
import tuiPlugin from "../src/tui.js"

describe("TUI plugin registration", () => {
  it("registers global keymap layer on 'app' slot without returning orphan text", async () => {
    let slotClaim: any = null
    let keymapLayerDef: any = null

    const mockContext = {
      ui: {
        slot: vi.fn((claim) => {
          slotClaim = claim
        }),
        toast: { show: vi.fn() },
        dialog: { confirm: vi.fn() },
      },
      keymap: {
        layer: vi.fn((fn) => {
          keymapLayerDef = fn()
        }),
      },
      client: {
        plugin: { list: vi.fn().mockResolvedValue([]) },
      },
      location: undefined,
      data: {
        location: { default: vi.fn().mockReturnValue("default") },
      },
    }

    await tuiPlugin.setup(mockContext as any)

    // Verify slot registration
    expect(mockContext.ui.slot).toHaveBeenCalledTimes(1)
    expect(slotClaim).toBeDefined()
    expect(slotClaim.append).toBe("app")

    // Execute slot render
    const renderResult = slotClaim.render()

    // Must NOT return a bare string, which causes OpenTUI:
    // "Orphan text error: ... must have a <text> as a parent"
    expect(typeof renderResult).not.toBe("string")
    expect(renderResult).toBeUndefined()

    // Verify keymap registration
    expect(mockContext.keymap.layer).toHaveBeenCalledTimes(1)
    expect(keymapLayerDef).toBeDefined()
    expect(keymapLayerDef.mode).toBe("global")

    const commandIds = keymapLayerDef.commands.map((c: any) => c.id)
    expect(commandIds).toContain("ssh.profiles.show")
    expect(commandIds).toContain("ssh.quick.disconnect")

    const slashNames = keymapLayerDef.commands.map((c: any) => c.slash?.name)
    expect(slashNames).toContain("ssh-profiles")
    expect(slashNames).toContain("ssh-disconnect-all")
  })
})
