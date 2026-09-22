import type { Client, SFTPWrapper } from "ssh2"
import { withTimeout } from "./agent-response.js"

export class SFTPManager {
  private client: Client
  private sftp: SFTPWrapper | null = null

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
        })
        sftp.on("end", () => {
          this.sftp = null
        })

        resolve(sftp)
      })
    })

    return withTimeout(sftpPromise, 10000, "SFTP subsystem handshake timed out after 10000ms.")
  }

  async readFile(
    remotePath: string,
    offset: number = 1,
    limit: number = 2000
  ): Promise<{ content: string; totalLines: number; hasMore: boolean }> {
    const sftp = await this.getSFTP()

    const readPromise = new Promise<{ content: string; totalLines: number; hasMore: boolean }>(
      (resolve, reject) => {
        sftp.readFile(remotePath, (err: any, data: Buffer) => {
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

    return withTimeout(readPromise, 15000, `Reading remote file '${remotePath}' timed out after 15000ms.`)
  }

  async writeFile(remotePath: string, content: string): Promise<void> {
    const sftp = await this.getSFTP()

    const writePromise = new Promise<void>((resolve, reject) => {
      sftp.writeFile(remotePath, content, "utf-8", (err) => {
        if (err) return reject(err)
        resolve()
      })
    })

    return withTimeout(writePromise, 15000, `Writing remote file '${remotePath}' timed out after 15000ms.`)
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

    // 1. Read existing file completely using standard buffer/string read
    const rawContent = await new Promise<string>((resolve, reject) => {
      sftp.readFile(remotePath, (err: any, data: Buffer) => {
        if (err) return reject(err)
        resolve(data.toString("utf-8"))
      })
    })

    // 2. Count occurrences
    const occurrences = rawContent.split(oldString).length - 1

    if (occurrences === 0) {
      throw new Error(`oldString was not found in '${remotePath}'.`)
    }

    if (occurrences > 1 && !replaceAll) {
      throw new Error(
        `oldString matched ${occurrences} times in '${remotePath}'. Provide more surrounding context to match uniquely, or set replaceAll to true.`
      )
    }

    // 3. Perform replacement
    const updatedContent = replaceAll
      ? rawContent.split(oldString).join(newString)
      : rawContent.replace(oldString, newString)

    // 4. Write updated content
    await this.writeFile(remotePath, updatedContent)

    return {
      replacements: replaceAll ? occurrences : 1,
      totalLines: updatedContent.split(/\r?\n/).length,
    }
  }

  close(): void {
    if (this.sftp) {
      try {
        this.sftp.end()
      } catch {}
      this.sftp = null
    }
  }
}
