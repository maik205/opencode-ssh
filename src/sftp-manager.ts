import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Client, SFTPWrapper, Stats, FileEntryWithStats, TransferOptions } from "ssh2"
import { withTimeout } from "./agent-response.js"
import type { SFTPFileEntry, SFTPListDirResult, SFTPStatResult } from "./types.js"

export function formatOctalMode(mode: number): string {
  return "0" + (mode & 0o777).toString(8).padStart(3, "0")
}

export function formatPermissions(mode: number, isDirectory: boolean, isSymlink: boolean): string {
  const typeChar = isDirectory ? "d" : isSymlink ? "l" : "-"
  const perms = [
    mode & 0o400 ? "r" : "-",
    mode & 0o200 ? "w" : "-",
    mode & 0o100 ? (mode & 0o4000 ? "s" : "x") : mode & 0o4000 ? "S" : "-",
    mode & 0o040 ? "r" : "-",
    mode & 0o020 ? "w" : "-",
    mode & 0o010 ? (mode & 0o2000 ? "s" : "x") : mode & 0o2000 ? "S" : "-",
    mode & 0o004 ? "r" : "-",
    mode & 0o002 ? "w" : "-",
    mode & 0o001 ? (mode & 0o1000 ? "t" : "x") : mode & 0o1000 ? "T" : "-",
  ].join("")
  return typeChar + perms
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B"
  const k = 1024
  const sizes = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1)
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`
}

export function resolveLocalPath(inputPath: string): string {
  const raw = (inputPath || ".").trim()
  if (raw === "~") {
    return os.homedir()
  }
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    const rel = raw.slice(2).replace(/[\\/]/g, path.sep)
    return path.join(os.homedir(), rel)
  }
  return path.resolve(process.cwd(), raw)
}

export class SFTPManager {
  private client: Client
  private sftp: SFTPWrapper | null = null
  private homeDir: string | null = null

  constructor(client: Client) {
    this.client = client
  }

  async getSFTP(): Promise<SFTPWrapper> {
    if (this.sftp) return this.sftp

    const sftpPromise = new Promise<SFTPWrapper>((resolve, reject) => {
      this.client.sftp((err, sftp) => {
        if (err) return reject(err)
        this.sftp = sftp

        sftp.on("close", () => {
          this.sftp = null
          this.homeDir = null
        })
        sftp.on("end", () => {
          this.sftp = null
          this.homeDir = null
        })

        resolve(sftp)
      })
    })

    return withTimeout(sftpPromise, 10000, "SFTP subsystem handshake timed out after 10000ms.")
  }

  async getHomeDir(): Promise<string> {
    if (this.homeDir) return this.homeDir
    const sftp = await this.getSFTP()
    return new Promise((resolve) => {
      sftp.realpath(".", (err, absPath) => {
        if (!err && absPath) {
          this.homeDir = absPath
          resolve(absPath)
        } else {
          this.homeDir = "/"
          resolve("/")
        }
      })
    })
  }

  async resolveRemotePath(inputPath: string): Promise<string> {
    const raw = (inputPath || ".").trim()
    if (raw === "" || raw === "." || raw === "~") {
      return await this.getHomeDir()
    }
    if (raw === "~/" || raw === "~\\") {
      return await this.getHomeDir()
    }
    if (raw.startsWith("~/") || raw.startsWith("~\\")) {
      const home = await this.getHomeDir()
      const rel = raw.slice(2).replace(/\\/g, "/")
      return path.posix.join(home, rel)
    }
    const normalized = raw.replace(/\\/g, "/")
    if (path.posix.isAbsolute(normalized)) {
      return path.posix.normalize(normalized)
    }
    const home = await this.getHomeDir()
    return path.posix.join(home, normalized)
  }

  async readFile(
    remotePath: string,
    offset: number = 1,
    limit: number = 2000
  ): Promise<{ content: string; totalLines: number; hasMore: boolean }> {
    const sftp = await this.getSFTP()
    const resolvedPath = await this.resolveRemotePath(remotePath)

    const readPromise = new Promise<{ content: string; totalLines: number; hasMore: boolean }>(
      (resolve, reject) => {
        sftp.readFile(resolvedPath, (err: any, data: Buffer) => {
          if (err) {
            return reject(err)
          }

          const str = data.toString("utf-8")
          const lines = str.split(/\r?\n/)
          const totalLines = lines.length

          const startIdx = Math.max(0, offset - 1)
          const endIdx = Math.min(totalLines, startIdx + limit)
          const selected = lines.slice(startIdx, endIdx)

          const formatted = selected
            .map((line: string, idx: number) => `${startIdx + idx + 1}: ${line}`)
            .join("\n")

          resolve({
            content: formatted,
            totalLines,
            hasMore: endIdx < totalLines,
          })
        })
      }
    )

    return withTimeout(readPromise, 15000, `Reading remote file '${resolvedPath}' timed out after 15000ms.`)
  }

  async writeFile(remotePath: string, content: string): Promise<void> {
    const sftp = await this.getSFTP()
    const resolvedPath = await this.resolveRemotePath(remotePath)

    const writePromise = new Promise<void>((resolve, reject) => {
      sftp.writeFile(resolvedPath, content, "utf-8", (err) => {
        if (err) return reject(err)
        resolve()
      })
    })

    return withTimeout(writePromise, 15000, `Writing remote file '${resolvedPath}' timed out after 15000ms.`)
  }

  async editFile(
    remotePath: string,
    oldString: string,
    newString: string,
    replaceAll: boolean = false
  ): Promise<{ replacements: number; totalLines: number }> {
    if (oldString === newString) {
      throw new Error("oldString and newString must differ.")
    }

    const sftp = await this.getSFTP()
    const resolvedPath = await this.resolveRemotePath(remotePath)

    // 1. Read existing file completely using standard buffer/string read
    const rawContent = await new Promise<string>((resolve, reject) => {
      sftp.readFile(resolvedPath, (err: any, data: Buffer) => {
        if (err) return reject(err)
        resolve(data.toString("utf-8"))
      })
    })

    // 2. Count occurrences
    const occurrences = rawContent.split(oldString).length - 1

    if (occurrences === 0) {
      throw new Error(`oldString was not found in '${resolvedPath}'.`)
    }

    if (occurrences > 1 && !replaceAll) {
      throw new Error(
        `oldString matched ${occurrences} times in '${resolvedPath}'. Provide more surrounding context to match uniquely, or set replaceAll to true.`
      )
    }

    // 3. Perform replacement
    const updatedContent = replaceAll
      ? rawContent.split(oldString).join(newString)
      : rawContent.replace(oldString, newString)

    // 4. Write updated content
    await this.writeFile(resolvedPath, updatedContent)

    return {
      replacements: replaceAll ? occurrences : 1,
      totalLines: updatedContent.split(/\r?\n/).length,
    }
  }

  async listDir(
    remotePath: string = ".",
    showHidden: boolean = true,
    sort: "name" | "size" | "mtime" = "name"
  ): Promise<SFTPListDirResult> {
    const sftp = await this.getSFTP()
    const resolvedPath = await this.resolveRemotePath(remotePath)

    const rawList = await withTimeout(
      new Promise<FileEntryWithStats[]>((resolve, reject) => {
        sftp.readdir(resolvedPath, (err, list) => {
          if (err) return reject(err)
          resolve(list)
        })
      }),
      20000,
      `Listing directory '${resolvedPath}' timed out after 20000ms.`
    )

    const entries: SFTPFileEntry[] = rawList
      .filter((e) => e.filename !== "." && e.filename !== "..")
      .filter((e) => showHidden || !e.filename.startsWith("."))
      .map((e) => {
        const isDir =
          typeof e.attrs.isDirectory === "function"
            ? e.attrs.isDirectory()
            : Boolean((e.attrs.mode & 0o170000) === 0o040000)
        const isSymlink =
          typeof e.attrs.isSymbolicLink === "function"
            ? e.attrs.isSymbolicLink()
            : Boolean((e.attrs.mode & 0o170000) === 0o120000)
        const isFile =
          typeof e.attrs.isFile === "function"
            ? e.attrs.isFile()
            : Boolean((e.attrs.mode & 0o170000) === 0o100000)
        const type = isDir ? "directory" : isSymlink ? "symlink" : isFile ? "file" : "other"

        const mtimeSec = typeof e.attrs.mtime === "number" && !isNaN(e.attrs.mtime) ? e.attrs.mtime : 0
        const atimeSec = typeof e.attrs.atime === "number" && !isNaN(e.attrs.atime) ? e.attrs.atime : 0

        return {
          name: e.filename,
          path: path.posix.join(resolvedPath, e.filename),
          type,
          size: e.attrs.size,
          sizeFormatted: formatBytes(e.attrs.size),
          permissions: formatPermissions(e.attrs.mode, isDir, isSymlink),
          mode: formatOctalMode(e.attrs.mode),
          mtime: new Date(mtimeSec * 1000).toISOString(),
          mtimeMs: mtimeSec * 1000,
          atime: new Date(atimeSec * 1000).toISOString(),
          atimeMs: atimeSec * 1000,
          uid: e.attrs.uid,
          gid: e.attrs.gid,
          isDirectory: isDir,
          isSymbolicLink: isSymlink,
        }
      })

    if (sort === "size") {
      entries.sort((a, b) => b.size - a.size)
    } else if (sort === "mtime") {
      entries.sort((a, b) => b.mtimeMs - a.mtimeMs)
    } else {
      entries.sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1
        if (!a.isDirectory && b.isDirectory) return 1
        return a.name.localeCompare(b.name)
      })
    }

    const directoriesCount = entries.filter((e) => e.isDirectory).length
    const filesCount = entries.filter((e) => !e.isDirectory).length

    return {
      path: resolvedPath,
      entries,
      totalCount: entries.length,
      directoriesCount,
      filesCount,
    }
  }

  async stat(remotePath: string): Promise<SFTPStatResult & { target?: string }> {
    const sftp = await this.getSFTP()
    const resolvedPath = await this.resolveRemotePath(remotePath)

    return withTimeout(
      new Promise<SFTPStatResult & { target?: string }>((resolve) => {
        sftp.lstat(resolvedPath, async (err, stats) => {
          if (err || !stats) {
            return resolve({
              path: resolvedPath,
              exists: false,
            })
          }

          const isDir =
            typeof stats.isDirectory === "function"
              ? stats.isDirectory()
              : Boolean((stats.mode & 0o170000) === 0o040000)
          const isSymlink =
            typeof stats.isSymbolicLink === "function"
              ? stats.isSymbolicLink()
              : Boolean((stats.mode & 0o170000) === 0o120000)
          const isFile =
            typeof stats.isFile === "function"
              ? stats.isFile()
              : Boolean((stats.mode & 0o170000) === 0o100000)
          const type = isDir ? "directory" : isSymlink ? "symlink" : isFile ? "file" : "other"

          let target: string | undefined = undefined
          if (isSymlink) {
            try {
              target = await new Promise<string>((res, rej) => {
                sftp.readlink(resolvedPath, (readErr, linkTarget) => {
                  if (readErr) return rej(readErr)
                  res(linkTarget)
                })
              })
            } catch {}
          }

          resolve({
            path: resolvedPath,
            exists: true,
            type,
            size: stats.size,
            sizeFormatted: formatBytes(stats.size),
            permissions: formatPermissions(stats.mode, isDir, isSymlink),
            mode: formatOctalMode(stats.mode),
            mtime:
              typeof stats.mtime === "number" && !isNaN(stats.mtime)
                ? new Date(stats.mtime * 1000).toISOString()
                : undefined,
            mtimeMs:
              typeof stats.mtime === "number" && !isNaN(stats.mtime)
                ? stats.mtime * 1000
                : undefined,
            atime:
              typeof stats.atime === "number" && !isNaN(stats.atime)
                ? new Date(stats.atime * 1000).toISOString()
                : undefined,
            atimeMs:
              typeof stats.atime === "number" && !isNaN(stats.atime)
                ? stats.atime * 1000
                : undefined,
            uid: stats.uid,
            gid: stats.gid,
            isDirectory: isDir,
            isFile,
            isSymbolicLink: isSymlink,
            ...(target ? { target } : {}),
          })
        })
      }),
      15000,
      `stat on '${resolvedPath}' timed out after 15000ms.`
    )
  }

  async mkdir(remotePath: string, recursive: boolean = true): Promise<void> {
    const sftp = await this.getSFTP()
    const resolvedPath = await this.resolveRemotePath(remotePath)

    if (!recursive) {
      return withTimeout(
        new Promise<void>((resolve, reject) => {
          sftp.mkdir(resolvedPath, (err) => {
            if (err) return reject(err)
            resolve()
          })
        }),
        15000,
        `mkdir '${resolvedPath}' timed out after 15000ms.`
      )
    }

    // Recursive mkdir
    const parts = resolvedPath.split("/").filter(Boolean)
    let current = resolvedPath.startsWith("/") ? "/" : ""

    for (const part of parts) {
      current = current === "/" ? `/${part}` : `${current}/${part}`
      const statResult = await new Promise<{ exists: boolean; isDir: boolean }>((resolve) => {
        sftp.stat(current, (err, stats) => {
          if (!err && stats) {
            const isDir =
              typeof stats.isDirectory === "function"
                ? stats.isDirectory()
                : Boolean((stats.mode & 0o170000) === 0o040000)
            resolve({ exists: true, isDir })
          } else {
            resolve({ exists: false, isDir: false })
          }
        })
      })

      if (statResult.exists) {
        if (!statResult.isDir) {
          throw new Error(`Cannot create directory at '${current}': Path exists and is not a directory.`)
        }
        continue
      }

      await new Promise<void>((resolve, reject) => {
        sftp.mkdir(current, (err) => {
          if (err) {
            sftp.stat(current, (statErr, stats) => {
              if (!statErr && stats) return resolve()
              reject(err)
            })
          } else {
            resolve()
          }
        })
      })
    }
  }

  async rm(remotePath: string, recursive: boolean = false): Promise<{ isDirectory: boolean }> {
    const sftp = await this.getSFTP()
    const resolvedPath = await this.resolveRemotePath(remotePath)

    const stats = await new Promise<Stats | null>((resolve) => {
      sftp.lstat(resolvedPath, (err, s) => {
        if (err) return resolve(null)
        resolve(s)
      })
    })

    if (!stats) {
      throw new Error(`Path '${remotePath}' does not exist.`)
    }

    const isDir =
      typeof stats.isDirectory === "function"
        ? stats.isDirectory()
        : Boolean((stats.mode & 0o170000) === 0o040000)

    if (!isDir) {
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          sftp.unlink(resolvedPath, (err) => {
            if (err) return reject(err)
            resolve()
          })
        }),
        15000,
        `Deleting file '${resolvedPath}' timed out after 15000ms.`
      )
      return { isDirectory: false }
    }

    // It is a directory
    if (!recursive) {
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          sftp.rmdir(resolvedPath, (err) => {
            if (err) return reject(err)
            resolve()
          })
        }),
        15000,
        `Deleting directory '${resolvedPath}' timed out after 15000ms.`
      )
      return { isDirectory: true }
    }

    // Recursive directory removal
    const removeDirRecursive = async (dirPath: string): Promise<void> => {
      const list = await new Promise<FileEntryWithStats[]>((resolve, reject) => {
        sftp.readdir(dirPath, (err, entries) => {
          if (err) return reject(err)
          resolve(entries)
        })
      })

      for (const entry of list) {
        if (entry.filename === "." || entry.filename === "..") continue
        const fullChild = path.posix.join(dirPath, entry.filename)
        const entryIsDir =
          typeof entry.attrs.isDirectory === "function"
            ? entry.attrs.isDirectory()
            : Boolean((entry.attrs.mode & 0o170000) === 0o040000)

        if (entryIsDir) {
          await removeDirRecursive(fullChild)
        } else {
          await new Promise<void>((resolve, reject) => {
            sftp.unlink(fullChild, (err) => {
              if (err) return reject(err)
              resolve()
            })
          })
        }
      }

      await new Promise<void>((resolve, reject) => {
        sftp.rmdir(dirPath, (err) => {
          if (err) return reject(err)
          resolve()
        })
      })
    }

    await withTimeout(
      removeDirRecursive(resolvedPath),
      60000,
      `Recursive directory deletion for '${resolvedPath}' timed out after 60000ms.`
    )
    return { isDirectory: true }
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const sftp = await this.getSFTP()
    const resolvedOld = await this.resolveRemotePath(oldPath)
    const resolvedNew = await this.resolveRemotePath(newPath)

    return withTimeout(
      new Promise<void>((resolve, reject) => {
        sftp.rename(resolvedOld, resolvedNew, (err) => {
          if (err) return reject(err)
          resolve()
        })
      }),
      15000,
      `Renaming '${resolvedOld}' to '${resolvedNew}' timed out after 15000ms.`
    )
  }

  async chmod(remotePath: string, mode: number | string): Promise<string> {
    const sftp = await this.getSFTP()
    const resolvedPath = await this.resolveRemotePath(remotePath)

    let numericMode: number
    if (typeof mode === "string") {
      numericMode = parseInt(mode, 8)
      if (isNaN(numericMode)) {
        throw new Error(`Invalid mode string '${mode}'. Provide an octal string like '0755' or '644'.`)
      }
    } else {
      numericMode = mode
    }

    await withTimeout(
      new Promise<void>((resolve, reject) => {
        sftp.chmod(resolvedPath, numericMode, (err) => {
          if (err) return reject(err)
          resolve()
        })
      }),
      15000,
      `chmod on '${resolvedPath}' timed out after 15000ms.`
    )

    return formatOctalMode(numericMode)
  }

  // === SCP & Fast File Transfers ===

  async fastPut(
    localPath: string,
    remotePath: string,
    options?: {
      concurrency?: number
      onProgress?: (transferred: number, total: number) => void
      timeoutMs?: number
    }
  ): Promise<{ localPath: string; remotePath: string; bytes: number }> {
    const sftp = await this.getSFTP()
    const resolvedLocal = resolveLocalPath(localPath)

    if (!fs.existsSync(resolvedLocal)) {
      throw new Error(`Local file '${localPath}' (resolved to '${resolvedLocal}') does not exist.`)
    }
    const localStat = fs.statSync(resolvedLocal)
    if (localStat.isDirectory()) {
      throw new Error(`Local path '${localPath}' is a directory. Set recursive: true to transfer directories.`)
    }

    let targetRemote = await this.resolveRemotePath(remotePath)
    const remoteEndsWithSlash = remotePath.endsWith("/") || remotePath.endsWith("\\")
    const remoteStat = await this.stat(targetRemote)

    if (remoteStat.exists && remoteStat.isDirectory) {
      targetRemote = path.posix.join(targetRemote, path.basename(resolvedLocal))
    } else if (remoteEndsWithSlash) {
      await this.mkdir(targetRemote, true)
      targetRemote = path.posix.join(targetRemote, path.basename(resolvedLocal))
    } else {
      const parentDir = path.posix.dirname(targetRemote)
      if (parentDir && parentDir !== "." && parentDir !== "/") {
        await this.mkdir(parentDir, true)
      }
    }

    const transferTimeout = options?.timeoutMs || 300000
    const transferPromise = new Promise<{ localPath: string; remotePath: string; bytes: number }>(
      (resolve, reject) => {
        const transferOpts: TransferOptions = {
          concurrency: options?.concurrency || 4,
          chunkSize: 32768,
          step: (transferred, _chunk, total) => {
            if (options?.onProgress) {
              options.onProgress(transferred, total)
            }
          },
        }

        sftp.fastPut(resolvedLocal, targetRemote, transferOpts, (err) => {
          if (err) return reject(err)
          resolve({
            localPath: resolvedLocal,
            remotePath: targetRemote,
            bytes: localStat.size,
          })
        })
      }
    )

    return withTimeout(
      transferPromise,
      transferTimeout,
      `Uploading '${localPath}' to '${targetRemote}' timed out after ${transferTimeout}ms.`
    )
  }

  async fastGet(
    remotePath: string,
    localPath: string,
    options?: {
      concurrency?: number
      onProgress?: (transferred: number, total: number) => void
      timeoutMs?: number
    }
  ): Promise<{ remotePath: string; localPath: string; bytes: number }> {
    const sftp = await this.getSFTP()
    const resolvedRemote = await this.resolveRemotePath(remotePath)

    const remoteStat = await this.stat(resolvedRemote)
    if (!remoteStat.exists) {
      throw new Error(`Remote file '${remotePath}' (resolved to '${resolvedRemote}') does not exist.`)
    }
    if (remoteStat.isDirectory) {
      throw new Error(`Remote path '${remotePath}' is a directory. Set recursive: true to transfer directories.`)
    }

    let targetLocal = resolveLocalPath(localPath)
    const localEndsWithSlash = localPath.endsWith("/") || localPath.endsWith("\\")
    let isLocalDir = false
    try {
      const st = fs.statSync(targetLocal)
      isLocalDir = st.isDirectory()
    } catch {}

    if (isLocalDir) {
      targetLocal = path.join(targetLocal, path.posix.basename(resolvedRemote))
    } else if (localEndsWithSlash) {
      fs.mkdirSync(targetLocal, { recursive: true })
      targetLocal = path.join(targetLocal, path.posix.basename(resolvedRemote))
    } else {
      fs.mkdirSync(path.dirname(targetLocal), { recursive: true })
    }

    const transferTimeout = options?.timeoutMs || 300000
    const transferPromise = new Promise<{ remotePath: string; localPath: string; bytes: number }>(
      (resolve, reject) => {
        const transferOpts: TransferOptions = {
          concurrency: options?.concurrency || 4,
          chunkSize: 32768,
          step: (transferred, _chunk, total) => {
            if (options?.onProgress) {
              options.onProgress(transferred, total)
            }
          },
        }

        sftp.fastGet(resolvedRemote, targetLocal, transferOpts, (err) => {
          if (err) return reject(err)
          resolve({
            remotePath: resolvedRemote,
            localPath: targetLocal,
            bytes: remoteStat.size || 0,
          })
        })
      }
    )

    return withTimeout(
      transferPromise,
      transferTimeout,
      `Downloading '${resolvedRemote}' to '${targetLocal}' timed out after ${transferTimeout}ms.`
    )
  }

  async uploadDir(
    localDir: string,
    remoteDir: string,
    options?: {
      concurrency?: number
      onProgress?: (file: string, transferredBytes: number, totalBytes?: number) => void
    }
  ): Promise<{ filesCount: number; directoriesCount: number; totalBytes: number }> {
    const resolvedLocal = resolveLocalPath(localDir)
    if (!fs.existsSync(resolvedLocal)) {
      throw new Error(`Local directory '${localDir}' does not exist.`)
    }
    const localStat = fs.statSync(resolvedLocal)
    if (!localStat.isDirectory()) {
      throw new Error(`Local path '${localDir}' is not a directory.`)
    }

    let targetRemote = await this.resolveRemotePath(remoteDir)
    const remoteStat = await this.stat(targetRemote)

    if (remoteStat.exists && remoteStat.isDirectory) {
      targetRemote = path.posix.join(targetRemote, path.basename(resolvedLocal))
    }

    await this.mkdir(targetRemote, true)

    let filesCount = 0
    let directoriesCount = 1
    let totalBytes = 0

    const uploadSubdir = async (localSub: string, remoteSub: string): Promise<void> => {
      const items = fs.readdirSync(localSub, { withFileTypes: true })
      for (const item of items) {
        const localItemPath = path.join(localSub, item.name)
        const remoteItemPath = path.posix.join(remoteSub, item.name)

        if (item.isDirectory()) {
          directoriesCount++
          await this.mkdir(remoteItemPath, true)
          await uploadSubdir(localItemPath, remoteItemPath)
        } else if (item.isFile() || item.isSymbolicLink()) {
          filesCount++
          const res = await this.fastPut(localItemPath, remoteItemPath, {
            concurrency: options?.concurrency,
            onProgress: (transferred, total) => {
              if (options?.onProgress) {
                options.onProgress(item.name, transferred, total)
              }
            },
          })
          totalBytes += res.bytes
        }
      }
    }

    await uploadSubdir(resolvedLocal, targetRemote)

    return {
      filesCount,
      directoriesCount,
      totalBytes,
    }
  }

  async downloadDir(
    remoteDir: string,
    localDir: string,
    options?: {
      concurrency?: number
      onProgress?: (file: string, transferredBytes: number, totalBytes?: number) => void
    }
  ): Promise<{ filesCount: number; directoriesCount: number; totalBytes: number }> {
    const resolvedRemote = await this.resolveRemotePath(remoteDir)
    const remoteStat = await this.stat(resolvedRemote)
    if (!remoteStat.exists) {
      throw new Error(`Remote directory '${remoteDir}' does not exist.`)
    }
    if (!remoteStat.isDirectory) {
      throw new Error(`Remote path '${remoteDir}' is not a directory.`)
    }

    let targetLocal = resolveLocalPath(localDir)
    let isLocalDir = false
    try {
      isLocalDir = fs.statSync(targetLocal).isDirectory()
    } catch {}

    if (isLocalDir) {
      targetLocal = path.join(targetLocal, path.posix.basename(resolvedRemote))
    }

    fs.mkdirSync(targetLocal, { recursive: true })

    let filesCount = 0
    let directoriesCount = 1
    let totalBytes = 0

    const downloadSubdir = async (remoteSub: string, localSub: string): Promise<void> => {
      const listing = await this.listDir(remoteSub, true)
      for (const item of listing.entries) {
        const localItemPath = path.join(localSub, item.name)
        if (item.isDirectory) {
          directoriesCount++
          fs.mkdirSync(localItemPath, { recursive: true })
          await downloadSubdir(item.path, localItemPath)
        } else {
          filesCount++
          const res = await this.fastGet(item.path, localItemPath, {
            concurrency: options?.concurrency,
            onProgress: (transferred, total) => {
              if (options?.onProgress) {
                options.onProgress(item.name, transferred, total)
              }
            },
          })
          totalBytes += res.bytes
        }
      }
    }

    await downloadSubdir(resolvedRemote, targetLocal)

    return {
      filesCount,
      directoriesCount,
      totalBytes,
    }
  }

  async copyToRemote(
    sourcePath: string,
    targetSftp: SFTPManager,
    destPath: string,
    options?: {
      recursive?: boolean
      onProgress?: (file: string, transferredBytes: number) => void
    }
  ): Promise<{ filesCount: number; directoriesCount: number; totalBytes: number; isDirectory: boolean }> {
    const sftpSource = await this.getSFTP()
    const sftpDest = await targetSftp.getSFTP()

    const resolvedSource = await this.resolveRemotePath(sourcePath)
    const sourceStat = await this.stat(resolvedSource)
    if (!sourceStat.exists) {
      throw new Error(`Source path '${sourcePath}' does not exist on source host.`)
    }

    let targetDest = await targetSftp.resolveRemotePath(destPath)
    const destStat = await targetSftp.stat(targetDest)

    if (!sourceStat.isDirectory) {
      // Single file transfer
      if (destStat.exists && destStat.isDirectory) {
        targetDest = path.posix.join(targetDest, path.posix.basename(resolvedSource))
      } else {
        const parentDir = path.posix.dirname(targetDest)
        if (parentDir && parentDir !== "/" && parentDir !== ".") {
          await targetSftp.mkdir(parentDir, true)
        }
      }

      let bytes = 0
      await new Promise<void>((resolve, reject) => {
        const readStream = sftpSource.createReadStream(resolvedSource)
        const writeStream = sftpDest.createWriteStream(targetDest)
        let done = false

        const onError = (err: any) => {
          if (!done) {
            done = true
            readStream.destroy()
            writeStream.destroy()
            reject(err)
          }
        }

        readStream.on("data", (chunk: Buffer) => {
          bytes += chunk.length
          if (options?.onProgress) {
            options.onProgress(path.posix.basename(resolvedSource), bytes)
          }
        })

        readStream.on("error", onError)
        writeStream.on("error", onError)
        writeStream.on("finish", () => {
          if (!done) {
            done = true
            resolve()
          }
        })

        readStream.pipe(writeStream)
      })

      return {
        filesCount: 1,
        directoriesCount: 0,
        totalBytes: bytes || sourceStat.size || 0,
        isDirectory: false,
      }
    }

    // Directory transfer
    if (!options?.recursive) {
      throw new Error(`Source path '${sourcePath}' is a directory. Set recursive: true to transfer directories.`)
    }

    if (destStat.exists && destStat.isDirectory) {
      targetDest = path.posix.join(targetDest, path.posix.basename(resolvedSource))
    }

    await targetSftp.mkdir(targetDest, true)

    let filesCount = 0
    let directoriesCount = 1
    let totalBytes = 0

    const copyDirRecursive = async (srcSub: string, dstSub: string): Promise<void> => {
      const listing = await this.listDir(srcSub, true)
      for (const item of listing.entries) {
        const dstItemPath = path.posix.join(dstSub, item.name)
        if (item.isDirectory) {
          directoriesCount++
          await targetSftp.mkdir(dstItemPath, true)
          await copyDirRecursive(item.path, dstItemPath)
        } else {
          filesCount++
          await new Promise<void>((resolve, reject) => {
            const readStream = sftpSource.createReadStream(item.path)
            const writeStream = sftpDest.createWriteStream(dstItemPath)
            let fileBytes = 0
            let done = false

            const onError = (err: any) => {
              if (!done) {
                done = true
                readStream.destroy()
                writeStream.destroy()
                reject(err)
              }
            }

            readStream.on("data", (chunk: Buffer) => {
              fileBytes += chunk.length
              totalBytes += chunk.length
              if (options?.onProgress) {
                options.onProgress(item.name, fileBytes)
              }
            })

            readStream.on("error", onError)
            writeStream.on("error", onError)
            writeStream.on("finish", () => {
              if (!done) {
                done = true
                resolve()
              }
            })

            readStream.pipe(writeStream)
          })
        }
      }
    }

    await copyDirRecursive(resolvedSource, targetDest)

    return {
      filesCount,
      directoriesCount,
      totalBytes,
      isDirectory: true,
    }
  }

  close(): void {
    if (this.sftp) {
      try {
        this.sftp.end()
      } catch {}
      this.sftp = null
    }
    this.homeDir = null
  }
}
