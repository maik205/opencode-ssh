import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  SFTPManager,
  formatBytes,
  formatOctalMode,
  formatPermissions,
} from "../src/sftp-manager.js"

describe("SFTP Helpers", () => {
  it("formats octal mode correctly", () => {
    expect(formatOctalMode(0o755)).toBe("0755")
    expect(formatOctalMode(0o644)).toBe("0644")
    expect(formatOctalMode(0o600)).toBe("0600")
    expect(formatOctalMode(0o700)).toBe("0700")
  })

  it("formats POSIX permissions correctly", () => {
    expect(formatPermissions(0o755, true, false)).toBe("drwxr-xr-x")
    expect(formatPermissions(0o644, false, false)).toBe("-rw-r--r--")
    expect(formatPermissions(0o777, false, true)).toBe("lrwxrwxrwx")
    expect(formatPermissions(0o4755, false, false)).toBe("-rwsr-xr-x")
    expect(formatPermissions(0o1777, true, false)).toBe("drwxrwxrwt")
  })

  it("formats byte counts in human readable format", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(512)).toBe("512 B")
    expect(formatBytes(1024)).toBe("1 KB")
    expect(formatBytes(1536)).toBe("1.5 KB")
    expect(formatBytes(1048576)).toBe("1 MB")
  })
})

describe("SFTPManager", () => {
  let mockSftp: any
  let mockClient: any
  let sftpManager: SFTPManager

  beforeEach(() => {
    mockSftp = {
      on: vi.fn(),
      realpath: vi.fn((p, cb) => cb(null, "/home/deploy")),
      readdir: vi.fn(),
      lstat: vi.fn(),
      stat: vi.fn(),
      mkdir: vi.fn(),
      rmdir: vi.fn(),
      unlink: vi.fn(),
      rename: vi.fn(),
      chmod: vi.fn(),
      readlink: vi.fn(),
      end: vi.fn(),
    }

    mockClient = {
      sftp: vi.fn((cb) => cb(null, mockSftp)),
    }

    sftpManager = new SFTPManager(mockClient)
  })

  it("resolves remote paths expanding ~ and relative paths", async () => {
    expect(await sftpManager.resolveRemotePath("~")).toBe("/home/deploy")
    expect(await sftpManager.resolveRemotePath("~/projects/app")).toBe("/home/deploy/projects/app")
    expect(await sftpManager.resolveRemotePath("~\\projects\\app")).toBe("/home/deploy/projects/app")
    expect(await sftpManager.resolveRemotePath("/var/log/syslog")).toBe("/var/log/syslog")
    expect(await sftpManager.resolveRemotePath("sub/file.txt")).toBe("/home/deploy/sub/file.txt")
  })

  it("lists directory contents with formatting, hidden filter, and sorting", async () => {
    const mockEntries = [
      {
        filename: ".",
        attrs: {
          isDirectory: () => true,
          isSymbolicLink: () => false,
          isFile: () => false,
          mode: 0o755,
          size: 4096,
          mtime: 1700000000,
          atime: 1700000000,
          uid: 1000,
          gid: 1000,
        },
      },
      {
        filename: "..",
        attrs: {
          isDirectory: () => true,
          isSymbolicLink: () => false,
          isFile: () => false,
          mode: 0o755,
          size: 4096,
          mtime: 1700000000,
          atime: 1700000000,
          uid: 1000,
          gid: 1000,
        },
      },
      {
        filename: ".env",
        attrs: {
          isDirectory: () => false,
          isSymbolicLink: () => false,
          isFile: () => true,
          mode: 0o600,
          size: 150,
          mtime: 1700000100,
          atime: 1700000100,
          uid: 1000,
          gid: 1000,
        },
      },
      {
        filename: "src",
        attrs: {
          isDirectory: () => true,
          isSymbolicLink: () => false,
          isFile: () => false,
          mode: 0o755,
          size: 4096,
          mtime: 1700000200,
          atime: 1700000200,
          uid: 1000,
          gid: 1000,
        },
      },
      {
        filename: "package.json",
        attrs: {
          isDirectory: () => false,
          isSymbolicLink: () => false,
          isFile: () => true,
          mode: 0o644,
          size: 2048,
          mtime: 1700000300,
          atime: 1700000300,
          uid: 1000,
          gid: 1000,
        },
      },
    ]

    mockSftp.readdir.mockImplementation((_p: string, cb: Function) => {
      cb(null, mockEntries)
    })

    // 1. With showHidden: true
    const resultAll = await sftpManager.listDir("/app", true, "name")
    expect(resultAll.totalCount).toBe(3) // . and .. filtered out
    expect(resultAll.directoriesCount).toBe(1)
    expect(resultAll.filesCount).toBe(2)
    // Directories first, then alphabetical
    expect(resultAll.entries[0].name).toBe("src")
    expect(resultAll.entries[0].isDirectory).toBe(true)
    expect(resultAll.entries[0].permissions).toBe("drwxr-xr-x")
    expect(resultAll.entries[1].name).toBe(".env")
    expect(resultAll.entries[2].name).toBe("package.json")

    // 2. With showHidden: false
    const resultVisible = await sftpManager.listDir("/app", false, "name")
    expect(resultVisible.totalCount).toBe(2)
    expect(resultVisible.entries.map((e) => e.name)).toEqual(["src", "package.json"])

    // 3. Sort by size
    const resultBySize = await sftpManager.listDir("/app", true, "size")
    expect(resultBySize.entries[0].name).toBe("src") // 4096 bytes
    expect(resultBySize.entries[1].name).toBe("package.json") // 2048 bytes
    expect(resultBySize.entries[2].name).toBe(".env") // 150 bytes

    // 4. Sort by mtime
    const resultByMtime = await sftpManager.listDir("/app", true, "mtime")
    expect(resultByMtime.entries[0].name).toBe("package.json") // 1700000300
    expect(resultByMtime.entries[1].name).toBe("src") // 1700000200
    expect(resultByMtime.entries[2].name).toBe(".env") // 1700000100
  })

  it("inspects file attributes via stat and detects non-existent paths", async () => {
    // Non-existent
    mockSftp.lstat.mockImplementationOnce((_p: string, cb: Function) => {
      cb(new Error("No such file"), null)
    })

    const notFound = await sftpManager.stat("/missing/path")
    expect(notFound.exists).toBe(false)
    expect(notFound.path).toBe("/missing/path")

    // Existing file
    mockSftp.lstat.mockImplementationOnce((_p: string, cb: Function) => {
      cb(null, {
        isDirectory: () => false,
        isSymbolicLink: () => false,
        isFile: () => true,
        mode: 0o644,
        size: 512,
        mtime: 1700000000,
        atime: 1700000000,
        uid: 1001,
        gid: 1001,
      })
    })

    const fileStat = await sftpManager.stat("/etc/hosts")
    expect(fileStat.exists).toBe(true)
    expect(fileStat.type).toBe("file")
    expect(fileStat.size).toBe(512)
    expect(fileStat.mode).toBe("0644")
    expect(fileStat.permissions).toBe("-rw-r--r--")
    expect(fileStat.isFile).toBe(true)
    expect(fileStat.isDirectory).toBe(false)

    // Existing symlink
    mockSftp.lstat.mockImplementationOnce((_p: string, cb: Function) => {
      cb(null, {
        isDirectory: () => false,
        isSymbolicLink: () => true,
        isFile: () => false,
        mode: 0o777,
        size: 12,
        mtime: 1700000000,
        atime: 1700000000,
        uid: 1001,
        gid: 1001,
      })
    })
    mockSftp.readlink.mockImplementationOnce((_p: string, cb: Function) => {
      cb(null, "/var/data/current")
    })

    const linkStat = await sftpManager.stat("/var/data/latest")
    expect(linkStat.exists).toBe(true)
    expect(linkStat.type).toBe("symlink")
    expect(linkStat.isSymbolicLink).toBe(true)
    expect(linkStat.target).toBe("/var/data/current")
  })

  it("handles mkdir non-recursive and recursive", async () => {
    // Non-recursive
    mockSftp.mkdir.mockImplementationOnce((_p: string, cb: Function) => cb(null))
    await sftpManager.mkdir("/tmp/single", false)
    expect(mockSftp.mkdir).toHaveBeenCalledWith("/tmp/single", expect.any(Function))

    // Recursive
    // When creating /a/b/c:
    // stat /a -> exists
    // stat /a/b -> does not exist -> mkdir /a/b
    // stat /a/b/c -> does not exist -> mkdir /a/b/c
    mockSftp.stat.mockImplementation((p: string, cb: Function) => {
      if (p === "/a") {
        cb(null, {
          isDirectory: () => true,
          mode: 0o755,
        })
      } else {
        cb(new Error("No such file"), null)
      }
    })

    const mkdirCalls: string[] = []
    mockSftp.mkdir.mockImplementation((p: string, cb: Function) => {
      mkdirCalls.push(p)
      cb(null)
    })

    await sftpManager.mkdir("/a/b/c", true)
    expect(mkdirCalls).toContain("/a/b")
    expect(mkdirCalls).toContain("/a/b/c")
  })

  it("handles rm for files and directories (with recursive removal)", async () => {
    // 1. File removal -> unlink
    mockSftp.lstat.mockImplementationOnce((_p: string, cb: Function) => {
      cb(null, {
        isDirectory: () => false,
        mode: 0o644,
      })
    })
    mockSftp.unlink.mockImplementationOnce((_p: string, cb: Function) => cb(null))

    const fileRm = await sftpManager.rm("/tmp/test.txt", false)
    expect(fileRm.isDirectory).toBe(false)
    expect(mockSftp.unlink).toHaveBeenCalledWith("/tmp/test.txt", expect.any(Function))

    // 2. Directory non-recursive removal -> rmdir
    mockSftp.lstat.mockImplementationOnce((_p: string, cb: Function) => {
      cb(null, {
        isDirectory: () => true,
        mode: 0o755,
      })
    })
    mockSftp.rmdir.mockImplementationOnce((_p: string, cb: Function) => cb(null))

    const dirRm = await sftpManager.rm("/tmp/emptydir", false)
    expect(dirRm.isDirectory).toBe(true)
    expect(mockSftp.rmdir).toHaveBeenCalledWith("/tmp/emptydir", expect.any(Function))

    // 3. Directory recursive removal
    mockSftp.lstat.mockImplementationOnce((_p: string, cb: Function) => {
      cb(null, {
        isDirectory: () => true,
        mode: 0o755,
      })
    })
    mockSftp.readdir.mockImplementationOnce((_p: string, cb: Function) => {
      cb(null, [
        {
          filename: "child.txt",
          attrs: { isDirectory: () => false, mode: 0o644 },
        },
      ])
    })
    mockSftp.unlink.mockImplementationOnce((_p: string, cb: Function) => cb(null))
    mockSftp.rmdir.mockImplementationOnce((_p: string, cb: Function) => cb(null))

    const recRm = await sftpManager.rm("/tmp/nested", true)
    expect(recRm.isDirectory).toBe(true)
    expect(mockSftp.unlink).toHaveBeenCalledWith("/tmp/nested/child.txt", expect.any(Function))
    expect(mockSftp.rmdir).toHaveBeenCalledWith("/tmp/nested", expect.any(Function))
  })

  it("handles rename and chmod", async () => {
    // Rename
    mockSftp.rename.mockImplementationOnce((_from: string, _to: string, cb: Function) => cb(null))
    await sftpManager.rename("old.txt", "new.txt")
    expect(mockSftp.rename).toHaveBeenCalledWith(
      "/home/deploy/old.txt",
      "/home/deploy/new.txt",
      expect.any(Function)
    )

    // Chmod with string octal
    mockSftp.chmod.mockImplementationOnce((_p: string, _m: number, cb: Function) => cb(null))
    const mode = await sftpManager.chmod("script.sh", "755")
    expect(mode).toBe("0755")
    expect(mockSftp.chmod).toHaveBeenCalledWith("/home/deploy/script.sh", 0o755, expect.any(Function))

    // Chmod with invalid string throws
    await expect(sftpManager.chmod("script.sh", "xyz")).rejects.toThrow("Invalid mode string")
  })
})
