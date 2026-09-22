import type { SSHSession } from "./ssh-session.js"
import type { SessionManager } from "./session-manager.js"

export interface MultiExecResult {
  host: string
  sessionID: string
  status: "success" | "error" | "timeout"
  exitCode: number | null
  stdout: string
  stderr: string
  durationMs: number
}

export interface BroadcastResult {
  command: string
  totalTargeted: number
  succeeded: number
  failed: number
  results: Record<string, MultiExecResult>
}

export async function broadcastCommand(
  sessionManager: SessionManager,
  targets: string[] | "all",
  command: string,
  timeoutMs: number = 60000
): Promise<BroadcastResult> {
  const openSessions = sessionManager.getAllOpenSessions()

  let selectedSessions: SSHSession[] = []

  if (targets === "all") {
    selectedSessions = openSessions
  } else {
    // Resolve each target (can be active session ID or profile name to auto-connect)
    for (const target of targets) {
      let s = sessionManager.getSession(target)
      if (!s || !s.isOpen()) {
        try {
          s = await sessionManager.getOrCreateSession(target)
        } catch (e) {
          console.error(`[oc-ssh] Broadcast failed to connect target ${target}:`, e)
        }
      }
      if (s && s.isOpen() && !selectedSessions.includes(s)) {
        selectedSessions.push(s)
      }
    }
  }

  if (selectedSessions.length === 0) {
    throw new Error("No matching connected or connectable SSH sessions found for broadcast.")
  }

  // Execute concurrently across all selected sessions
  const results: Record<string, MultiExecResult> = {}
  let succeeded = 0
  let failed = 0

  await Promise.all(
    selectedSessions.map(async (session) => {
      const startTime = Date.now()
      try {
        const res = await session.exec(command, timeoutMs)
        const isSuccess = res.exitCode === 0
        if (isSuccess) succeeded++
        else failed++

        results[session.id] = {
          host: session.host,
          sessionID: session.id,
          status: isSuccess ? "success" : "error",
          exitCode: res.exitCode,
          stdout: res.stdout,
          stderr: res.stderr,
          durationMs: res.durationMs,
        }
      } catch (err: any) {
        failed++
        results[session.id] = {
          host: session.host,
          sessionID: session.id,
          status: err.message?.includes("timed out") ? "timeout" : "error",
          exitCode: null,
          stdout: "",
          stderr: err.message || String(err),
          durationMs: Date.now() - startTime,
        }
      }
    })
  )

  return {
    command,
    totalTargeted: selectedSessions.length,
    succeeded,
    failed,
    results,
  }
}
