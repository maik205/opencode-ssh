import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { ConfigManager, parseSshConfig } from "../src/config.js"

describe("ConfigManager & SSH Config parser", () => {
  const testDir = path.join(os.tmpdir(), "oc-ssh-test-" + Date.now())

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true })
    } catch {}
  })

  it("saves and retrieves custom profiles", async () => {
    const configManager = new ConfigManager(testDir)
    await configManager.save({
      name: "test-prod",
      host: "prod.example.com",
      port: 2222,
      username: "deploy",
      description: "Production box",
    })

    const retrieved = await configManager.get("test-prod")
    expect(retrieved).toBeDefined()
    expect(retrieved?.name).toBe("test-prod")
    expect(retrieved?.host).toBe("prod.example.com")
    expect(retrieved?.port).toBe(2222)
    expect(retrieved?.username).toBe("deploy")
  })

  it("lists custom profiles alongside any system ssh profiles", async () => {
    const configManager = new ConfigManager(testDir)
    await configManager.save({
      name: "alpha-server",
      host: "alpha.internal",
      username: "admin",
    })

    const list = await configManager.list()
    const found = list.find((p) => p.name === "alpha-server")
    expect(found).toBeDefined()
    expect(found?.host).toBe("alpha.internal")
  })

  it("removes profiles successfully", async () => {
    const configManager = new ConfigManager(testDir)
    await configManager.save({
      name: "temp-server",
      host: "temp.internal",
    })

    const removed = await configManager.remove("temp-server")
    expect(removed).toBe(true)

    const check = await configManager.get("temp-server")
    expect(check).toBeUndefined()
  })
})
