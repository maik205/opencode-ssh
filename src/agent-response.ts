import { pruneEmpty } from "./string-utils.js"

export interface AgentToolResult<T = any> {
  success: boolean
  data?: T
  error?: {
    code: string
    message: string
    hint?: string
    details?: any
  }
}

export function successResult<T>(data: T): { content: string } {
  const payload = (typeof data === "object" && data !== null && !Array.isArray(data))
    ? data
    : { result: data }

  const pruned = pruneEmpty(payload)

  return {
    content: JSON.stringify({
      success: true,
      ...pruned,
    }),
  }
}

export function errorResult(
  code: string,
  message: string,
  hint?: string,
  details?: any
): { content: string } {
  const errorObj: Record<string, any> = { code, message }
  if (hint) errorObj.hint = hint
  if (details !== undefined && details !== null) errorObj.details = details

  return {
    content: JSON.stringify({
      success: false,
      error: errorObj,
    }),
  }
}

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  timeoutMessage: string
): Promise<T> {
  let timer: NodeJS.Timeout
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(timeoutMessage))
    }, ms)
  })

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timer)
  })
}
