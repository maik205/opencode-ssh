import type { SSHSession } from "./ssh-session.js"

export interface BackgroundJob {
  id: string
  command: string
  remotePid?: number
  startedAt: number
  status: "running" | "completed" | "failed" | "terminated"
  exitCode?: number
  logFile: string
  pidFile: string
}

export class JobManager {
  private session: SSHSession
  private jobs = new Map<string, BackgroundJob>()

  constructor(session: SSHSession) {
    this.session = session
  }

  async spawnJob(command: string): Promise<BackgroundJob> {
    const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`
    const logFile = `/tmp/oc_job_${jobId}.log`
    const pidFile = `/tmp/oc_job_${jobId}.pid`

    // Supervised background runner using nohup/subshell with exit code logging
    // Base64 encode the inner command to avoid quote escaping issues
    const b64 = Buffer.from(command, "utf-8").toString("base64")
    const script = `
nohup bash -c '
  echo $$ > "${pidFile}"
  echo "${b64}" | base64 -d | bash > "${logFile}" 2>&1
  EXIT_CODE=$?
  echo $EXIT_CODE > "${logFile}.exit"
' >/dev/null 2>&1 &
`
    await this.session.exec(script)

    // Wait a brief moment for the PID file to be created
    let remotePid: number | undefined
    try {
      const pidRes = await this.session.exec(`cat "${pidFile}" 2>/dev/null`)
      const parsed = parseInt(pidRes.stdout.trim(), 10)
      if (!isNaN(parsed)) {
        remotePid = parsed
      }
    } catch {}

    const job: BackgroundJob = {
      id: jobId,
      command,
      remotePid,
      startedAt: Date.now(),
      status: "running",
      logFile,
      pidFile,
    }

    this.jobs.set(jobId, job)
    return job
  }

  async getJobStatus(jobId: string): Promise<BackgroundJob & { isAlive: boolean; exitCode?: number }> {
    const job = this.jobs.get(jobId)
    if (!job) {
      throw new Error(`Job '${jobId}' not found.`)
    }

    // Check exit file
    const exitRes = await this.session.exec(`cat "${job.logFile}.exit" 2>/dev/null`)
    const exitStr = exitRes.stdout.trim()

    if (exitStr !== "") {
      const code = parseInt(exitStr, 10)
      job.exitCode = isNaN(code) ? 0 : code
      job.status = job.exitCode === 0 ? "completed" : "failed"
      return { ...job, isAlive: false }
    }

    // Check if process is still running via PID
    if (job.remotePid) {
      const checkRes = await this.session.exec(`kill -0 ${job.remotePid} 2>/dev/null && echo "ALIVE"`)
      const isAlive = checkRes.stdout.includes("ALIVE")
      if (!isAlive) {
        // Exited without exit code file yet or terminated abruptly
        job.status = "terminated"
        return { ...job, isAlive: false }
      }
      return { ...job, isAlive: true }
    }

    return { ...job, isAlive: true }
  }

  async getJobLogs(jobId: string, lines: number = 100): Promise<{ logs: string; isRunning: boolean }> {
    const job = this.jobs.get(jobId)
    if (!job) {
      throw new Error(`Job '${jobId}' not found.`)
    }

    const res = await this.session.exec(`tail -n ${lines} "${job.logFile}" 2>/dev/null`)
    const status = await this.getJobStatus(jobId)

    return {
      logs: res.stdout || "(No output yet)",
      isRunning: status.isAlive,
    }
  }

  async killJob(jobId: string, signal: "SIGINT" | "SIGTERM" | "SIGKILL" = "SIGTERM"): Promise<boolean> {
    const job = this.jobs.get(jobId)
    if (!job) {
      throw new Error(`Job '${jobId}' not found.`)
    }

    if (job.remotePid) {
      const sigFlag = signal === "SIGKILL" ? "-9" : signal === "SIGINT" ? "-2" : "-15"
      await this.session.exec(`kill ${sigFlag} ${job.remotePid} 2>/dev/null || kill ${sigFlag} -${job.remotePid} 2>/dev/null`)
      job.status = "terminated"
      return true
    }

    return false
  }

  listJobs(): BackgroundJob[] {
    return Array.from(this.jobs.values())
  }
}
