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
  return {
    content: JSON.stringify(
      {
        success: true,
        ...((typeof data === "object" && data !== null && !Array.isArray(data)) ? data : { result: data }),
      },
      null,
      2
    ),
  }
}

export function errorResult(
  code: string,
  message: string,
  hint?: string,
  details?: any
): { content: string } {
  return {
    content: JSON.stringify(
      {
        success: false,
        error: {
          code,
          message,
          hint,
          details,
        },
      },
      null,
      2
    ),
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
