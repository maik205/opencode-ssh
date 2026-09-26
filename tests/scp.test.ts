import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { Readable, Writable } from "node:stream"
import {
  SFTPManager,
  resolveLocalPath,
  formatBytes,
} from "../src/sftp-manager.js"
import plugin from "../src/index.js"

describe("SCP & File Transfer Utilities", () => {
  const tempBaseDir = path.join(os.tmpdir(), "oc-ssh-scp-test-" + Date.now())

  beforeEach(() => {
    fs.mkdirSync(tempBaseDir, { recursive: true })
  })

  afterEach(() => {
    try {
      fs.rmSync(tempBaseDir, { recursive: true, force: true })
    } catch {}
  })

  describe("resolveLocalPath", () => {
    it("expands ~ to user home directory", () => {
      expect(resolveLocalPath("~")).toBe(os.homedir())
      expect(resolveLocalPath("~/foo/bar.txt")).toBe(path.join(os.homedir(), "foo/bar.txt"))
      expect(resolveLocalPath("~\\foo\\bar.txt")).toBe(path.join(os.homedir(), "foo", "bar.txt"))
    })

    it("resolves relative paths against current working directory", () => {
      expect(resolveLocalPath("foo.txt")).toBe(path.resolve(process.cwd(), "foo.txt"))
      expect(resolveLocalPath("./dir/foo.txt")).toBe(path.resolve(process.cwd(), "dir/foo.txt"))
    })

    it("preserves absolute paths", () => {
      const absPath = path.resolve("/some/absolute/path")
      expect(resolveLocalPath(absPath)).toBe(absPath)
    })
  })

  describe("SFTPManager fastPut (Upload)", () => {
    let mockSftp: any
    let mockClient: any
    let sftpManager: SFTPManager

    beforeEach(() => {
      mockSftp = {
        on: vi.fn(),
        realpath: vi.fn((_p, cb) => cb(null, "/home/deploy")),
        stat: vi.fn((p, cb) => {
          if (p === "/remote/existing_dir") {
            cb(null, { isDirectory: () => true, mode: 0o755, size: 4096 })
          } else {
            cb(new Error("No such file"), null)
          }
        }),
        lstat: vi.fn((p, cb) => {
          if (p === "/remote/existing_dir") {
            cb(null, { isDirectory: () => true, mode: 0o755, size: 4096 })
          } else {
            cb(new Error("No such file"), null)
          }
        }),
        mkdir: vi.fn((_p, cb) => cb(null)),
        fastPut: vi.fn((_local, _remote, opts, cb) => {
          opts?.step?.(100, 100, 100)
          cb(null)
        }),
      }

      mockClient = {
        sftp: vi.fn((cb) => cb(null, mockSftp)),
      }

      sftpManager = new SFTPManager(mockClient)
    })

    it("uploads a local file to remote target path", async () => {
      const localFile = path.join(tempBaseDir, "file.txt")
      fs.writeFileSync(localFile, "hello local file")

      let progressCalled = false
      const result = await sftpManager.fastPut(localFile, "/remote/dest.txt", {
        onProgress: () => {
          progressCalled = true
        },
      })

      expect(result.localPath).toBe(localFile)
      expect(result.remotePath).toBe("/remote/dest.txt")
      expect(result.bytes).toBe(16)
      expect(mockSftp.fastPut).toHaveBeenCalledWith(
        localFile,
        "/remote/dest.txt",
        expect.any(Object),
        expect.any(Function)
      )
      expect(progressCalled).toBe(true)
    })

    it("appends basename when remote target is an existing directory", async () => {
      const localFile = path.join(tempBaseDir, "config.json")
      fs.writeFileSync(localFile, '{"key": "val"}')

      const result = await sftpManager.fastPut(localFile, "/remote/existing_dir")
      expect(result.remotePath).toBe("/remote/existing_dir/config.json")
      expect(mockSftp.fastPut).toHaveBeenCalledWith(
        localFile,
        "/remote/existing_dir/config.json",
        expect.any(Object),
        expect.any(Function)
      )
    })

    it("throws when local file does not exist", async () => {
      await expect(
        sftpManager.fastPut(path.join(tempBaseDir, "nonexistent.txt"), "/remote/dest.txt")
      ).rejects.toThrow("does not exist")
    })

    it("throws when local path is a directory (directing user to recursive)", async () => {
      await expect(
        sftpManager.fastPut(tempBaseDir, "/remote/dest")
      ).rejects.toThrow("Set recursive: true to transfer directories")
    })
  })

  describe("SFTPManager fastGet (Download)", () => {
    let mockSftp: any
    let mockClient: any
    let sftpManager: SFTPManager

    beforeEach(() => {
      mockSftp = {
        on: vi.fn(),
        realpath: vi.fn((_p, cb) => cb(null, "/home/deploy")),
        stat: vi.fn((p, cb) => {
          if (p === "/remote/server.log") {
            cb(null, { isDirectory: () => false, mode: 0o644, size: 500 })
          } else if (p === "/remote/dir") {
            cb(null, { isDirectory: () => true, mode: 0o755, size: 4096 })
          } else {
            cb(new Error("Not found"), null)
          }
        }),
        lstat: vi.fn((p, cb) => {
          if (p === "/remote/server.log") {
            cb(null, { isDirectory: () => false, isFile: () => true, mode: 0o644, size: 500 })
          } else if (p === "/remote/dir") {
            cb(null, { isDirectory: () => true, isFile: () => false, mode: 0o755, size: 4096 })
          } else {
            cb(new Error("Not found"), null)
          }
        }),
        fastGet: vi.fn((_remote, _local, opts, cb) => {
          opts?.step?.(500, 500, 500)
          cb(null)
        }),
      }

      mockClient = {
        sftp: vi.fn((cb) => cb(null, mockSftp)),
      }

      sftpManager = new SFTPManager(mockClient)
    })

    it("downloads a remote file to local target path", async () => {
      const localDest = path.join(tempBaseDir, "downloaded.log")

      let progressCalled = false
      const result = await sftpManager.fastGet("/remote/server.log", localDest, {
        onProgress: () => {
          progressCalled = true
        },
      })

      expect(result.remotePath).toBe("/remote/server.log")
      expect(result.localPath).toBe(localDest)
      expect(result.bytes).toBe(500)
      expect(mockSftp.fastGet).toHaveBeenCalledWith(
        "/remote/server.log",
        localDest,
        expect.any(Object),
        expect.any(Function)
      )
      expect(progressCalled).toBe(true)
    })

    it("appends basename when local destination is an existing directory", async () => {
      const result = await sftpManager.fastGet("/remote/server.log", tempBaseDir)
      const expected = path.join(tempBaseDir, "server.log")
      expect(result.localPath).toBe(expected)
      expect(mockSftp.fastGet).toHaveBeenCalledWith(
        "/remote/server.log",
        expected,
        expect.any(Object),
        expect.any(Function)
      )
    })

    it("throws when remote file does not exist", async () => {
      await expect(
        sftpManager.fastGet("/remote/missing.txt", path.join(tempBaseDir, "out.txt"))
      ).rejects.toThrow("does not exist")
    })

    it("throws when remote file is a directory", async () => {
      await expect(
        sftpManager.fastGet("/remote/dir", path.join(tempBaseDir, "out"))
      ).rejects.toThrow("Set recursive: true to transfer directories")
    })
  })

  describe("SFTPManager uploadDir and downloadDir", () => {
    let mockSftp: any
    let mockClient: any
    let sftpManager: SFTPManager

    beforeEach(() => {
      mockSftp = {
        on: vi.fn(),
        realpath: vi.fn((_p, cb) => cb(null, "/home/deploy")),
        stat: vi.fn((_p, cb) => cb(new Error("not found"), null)),
        lstat: vi.fn((_p, cb) => cb(new Error("not found"), null)),
        mkdir: vi.fn((_p, cb) => cb(null)),
        readdir: vi.fn(),
        fastPut: vi.fn((_local, _remote, _opts, cb) => cb(null)),
        fastGet: vi.fn((_remote, _local, _opts, cb) => cb(null)),
      }

      mockClient = {
        sftp: vi.fn((cb) => cb(null, mockSftp)),
      }

      sftpManager = new SFTPManager(mockClient)
    })

    it("recursively uploads directory tree", async () => {
      const uploadRoot = path.join(tempBaseDir, "upload_tree")
      fs.mkdirSync(path.join(uploadRoot, "nested"), { recursive: true })
      fs.writeFileSync(path.join(uploadRoot, "a.txt"), "hello A")
      fs.writeFileSync(path.join(uploadRoot, "nested", "b.txt"), "hello B in sub")

      const res = await sftpManager.uploadDir(uploadRoot, "/remote/project")
      expect(res.filesCount).toBe(2)
      expect(res.directoriesCount).toBe(2) // root + nested
      expect(res.totalBytes).toBe(7 + 14) // "hello A" + "hello B in sub"
      expect(mockSftp.fastPut).toHaveBeenCalledTimes(2)
    })

    it("recursively downloads directory tree", async () => {
      const downloadTarget = path.join(tempBaseDir, "download_target")

      // remote /remote/dir has 1 subfolder and 1 file
      mockSftp.stat.mockImplementation((p: string, cb: Function) => {
        if (p === "/remote/dir" || p === "/remote/dir/sub") {
          cb(null, { isDirectory: () => true, mode: 0o755 })
        } else if (p.includes("child")) {
          cb(null, { isDirectory: () => false, mode: 0o644, size: 50 })
        } else {
          cb(null, { isDirectory: () => false, mode: 0o644, size: 100 })
        }
      })
      mockSftp.lstat.mockImplementation((p: string, cb: Function) => {
        if (p === "/remote/dir" || p === "/remote/dir/sub") {
          cb(null, { isDirectory: () => true, isFile: () => false, mode: 0o755 })
        } else if (p.includes("child")) {
          cb(null, { isDirectory: () => false, isFile: () => true, mode: 0o644, size: 50 })
        } else {
          cb(null, { isDirectory: () => false, isFile: () => true, mode: 0o644, size: 100 })
        }
      })

      mockSftp.readdir.mockImplementation((dirPath: string, cb: Function) => {
        if (dirPath === "/remote/dir") {
          cb(null, [
            { filename: "sub", attrs: { isDirectory: () => true, mode: 0o755 } },
            { filename: "root.txt", attrs: { isDirectory: () => false, isFile: () => true, mode: 0o644, size: 100 } },
          ])
        } else if (dirPath === "/remote/dir/sub") {
          cb(null, [
            { filename: "child.txt", attrs: { isDirectory: () => false, isFile: () => true, mode: 0o644, size: 50 } },
          ])
        } else {
          cb(null, [])
        }
      })

      const res = await sftpManager.downloadDir("/remote/dir", downloadTarget)
      expect(res.filesCount).toBe(2)
      expect(res.directoriesCount).toBe(2) // root + sub
      expect(res.totalBytes).toBe(150)
      expect(mockSftp.fastGet).toHaveBeenCalledTimes(2)
    })
  })

  describe("SFTPManager copyToRemote (Remote-to-Remote)", () => {
    let sourceManager: SFTPManager
    let targetManager: SFTPManager
    let mockSourceSftp: any
    let mockTargetSftp: any

    beforeEach(() => {
      mockSourceSftp = {
        on: vi.fn(),
        realpath: vi.fn((_p, cb) => cb(null, "/home/source")),
        stat: vi.fn((p, cb) => {
          if (p === "/source/file.txt") {
            cb(null, { isDirectory: () => false, mode: 0o644, size: 12 })
          } else {
            cb(new Error("not found"), null)
          }
        }),
        lstat: vi.fn((p, cb) => {
          if (p === "/source/file.txt") {
            cb(null, { isDirectory: () => false, isFile: () => true, mode: 0o644, size: 12 })
          } else {
            cb(new Error("not found"), null)
          }
        }),
        createReadStream: vi.fn((_path: string) => {
          return Readable.from([Buffer.from("streamed data")])
        }),
      }

      mockTargetSftp = {
        on: vi.fn(),
        realpath: vi.fn((_p, cb) => cb(null, "/home/target")),
        stat: vi.fn((_p, cb) => cb(new Error("not found"), null)),
        lstat: vi.fn((_p, cb) => cb(new Error("not found"), null)),
        mkdir: vi.fn((_p, cb) => cb(null)),
        createWriteStream: vi.fn((_path: string) => {
          return new Writable({
            write(_chunk, _enc, cb) {
              cb()
            },
          })
        }),
      }

      const clientA: any = { sftp: (cb: any) => cb(null, mockSourceSftp) }
      const clientB: any = { sftp: (cb: any) => cb(null, mockTargetSftp) }

      sourceManager = new SFTPManager(clientA)
      targetManager = new SFTPManager(clientB)
    })

    it("streams a file directly between two remote hosts", async () => {
      let progressCalled = false
      const result = await sourceManager.copyToRemote(
        "/source/file.txt",
        targetManager,
        "/target/dest.txt",
        {
          onProgress: () => {
            progressCalled = true
          },
        }
      )

      expect(result.filesCount).toBe(1)
      expect(result.isDirectory).toBe(false)
      expect(result.totalBytes).toBe(13) // "streamed data".length = 13
      expect(mockSourceSftp.createReadStream).toHaveBeenCalledWith("/source/file.txt")
      expect(mockTargetSftp.createWriteStream).toHaveBeenCalledWith("/target/dest.txt")
      expect(progressCalled).toBe(true)
    })
  })

  describe("ssh_scp OpenCode Tool Registration and Execution", () => {
    let tools: Record<string, any> = {}

    beforeEach(async () => {
      tools = {}
      const mockCtx: any = {
        tool: {
          transform: async (fn: any) => {
            await fn({
              namespace: vi.fn(),
              add: (toolDef: any) => {
                tools[toolDef.name] = toolDef
              },
            })
          },
        },
      }
      await plugin.setup(mockCtx)
    })

    it("registers ssh_scp tool with correct schema", () => {
      expect(tools["ssh_scp"]).toBeDefined()
      expect(tools["ssh_scp"].description).toContain("Securely copy files")
      expect(tools["ssh_scp"].input.properties.direction).toBeDefined()
      expect(tools["ssh_scp"].input.properties.sourcePath).toBeDefined()
      expect(tools["ssh_scp"].input.properties.destPath).toBeDefined()
      expect(tools["ssh_scp"].input.properties.targetSessionID).toBeDefined()
    })

    it("validates invalid transfer direction", async () => {
      const res = await tools["ssh_scp"].execute(
        {
          direction: "invalid_dir",
          sourcePath: "a",
          destPath: "b",
        },
        { progress: vi.fn() }
      )
      const data = JSON.parse(res.content)
      expect(data.success).toBe(false)
      expect(data.error.code).toBe("INVALID_DIRECTION")
    })

    it("validates missing targetSessionID for remote_to_remote", async () => {
      const res = await tools["ssh_scp"].execute(
        {
          direction: "remote_to_remote",
          sourcePath: "/remote/a",
          destPath: "/remote/b",
        },
        { progress: vi.fn() }
      )
      const data = JSON.parse(res.content)
      expect(data.success).toBe(false)
      expect(data.error.code).toBe("MISSING_TARGET_SESSION")
    })

    it("validates nonexistent local source file on upload", async () => {
      const res = await tools["ssh_scp"].execute(
        {
          direction: "upload",
          sourcePath: path.join(tempBaseDir, "does-not-exist.txt"),
          destPath: "/remote/dest.txt",
        },
        { progress: vi.fn() }
      )
      const data = JSON.parse(res.content)
      expect(data.success).toBe(false)
      expect(data.error.code).toBe("SCP_UPLOAD_FAILED")
    })

    it("rejects local directory upload if recursive is false", async () => {
      const localDir = path.join(tempBaseDir, "some-dir")
      fs.mkdirSync(localDir)

      const res = await tools["ssh_scp"].execute(
        {
          direction: "upload",
          sourcePath: localDir,
          destPath: "/remote/dir",
          recursive: false,
        },
        { progress: vi.fn() }
      )
      const data = JSON.parse(res.content)
      expect(data.success).toBe(false)
      expect(data.error.code).toBe("SCP_DIRECTORY_REQUIRES_RECURSIVE")
    })
  })
})
