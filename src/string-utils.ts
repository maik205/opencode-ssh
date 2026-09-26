/**
 * String and whitespace utilities for agent tool use:
 * - Robust ANSI/OSC stripping and control character filtering
 * - Terminal carriage return (\r) and backspace (\b) simulation for progress bars/spinners
 * - Line-ending normalization (CRLF <-> LF)
 * - Trailing whitespace and excess blank lines cleanup
 * - Smart whitespace-tolerant matching for file editing
 * - Smart output truncation to prevent context window explosion
 * - JSON pruning and token reduction helpers
 */

// Full ANSI / VT100 / xterm escape code regex
// Matches CSI sequences (\x1b[...m), OSC sequences (\x1b]...\x07), cursor movements, colors, etc.
const ANSI_REGEX = new RegExp(
  [
    "[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%_~]*)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%_~]*)*)?\\u0007)",
    "(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))",
  ].join("|"),
  "g"
)

// OSC hyperlink and title sequences
const OSC_REGEX = /\u001b\][^\u001b\u0007]*(\u001b\\|\u0007)/g

// Non-printable control characters except standard whitespace (\t, \n)
// Note: \r is handled explicitly by resolveCarriageReturns
const CONTROL_CHAR_REGEX = /[\u0000-\u0007\u000B-\u000C\u000E-\u001F\u007F-\u009F]/g

/**
 * Normalizes command strings from agents:
 * - Strips UTF-8 BOM
 * - Converts CRLF and lone CR to standard Unix LF
 * - Trims outer whitespace and blank lines while preserving indentation of multiline scripts
 */
export function normalizeCommand(command: string): string {
  if (!command || typeof command !== "string") return ""
  return command
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim()
}

/**
 * Normalizes file and directory paths:
 * - Trims whitespace and surrounding newlines
 * - Converts backslashes to forward slashes for POSIX/remote paths
 */
export function normalizePath(pathStr: string): string {
  if (!pathStr || typeof pathStr !== "string") return ""
  return pathStr.trim().replace(/\\/g, "/")
}

/**
 * Simulates terminal carriage returns (\r) and backspaces (\b) across lines.
 * Terminal progress indicators, spinners, and download meters (curl, docker, npm, git)
 * repeatedly overwrite lines using \r without \n. This collapses intermediate frames
 * into the effective final line, preventing token inflation.
 */
export function resolveCarriageReturns(text: string): string {
  if (!text.includes("\r") && !text.includes("\b")) return text

  return text
    .split("\n")
    .map((line) => {
      if (!line.includes("\r") && !line.includes("\b")) return line

      // Handle backspaces first
      let cleaned = line
      if (cleaned.includes("\b")) {
        let buf = ""
        for (let i = 0; i < cleaned.length; i++) {
          if (cleaned[i] === "\b") {
            buf = buf.slice(0, -1)
          } else {
            buf += cleaned[i]
          }
        }
        cleaned = buf
      }

      // Handle carriage returns (\r): take the final overwritten frame
      if (cleaned.includes("\r")) {
        const segments = cleaned.split("\r").filter((s) => s.length > 0)
        return segments.length > 0 ? segments[segments.length - 1] : ""
      }

      return cleaned
    })
    .join("\n")
}

/**
 * Trims useless trailing whitespace from every line while preserving
 * meaningful leading indentation (spaces/tabs).
 */
export function cleanLineWhitespace(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
}

/**
 * Collapses 3 or more consecutive newlines down to 2 newlines (\n\n),
 * preserving section breaks without wasting tokens on empty lines.
 */
export function collapseBlankLines(text: string, maxConsecutive: number = 2): string {
  const regex = new RegExp(`\\n{${maxConsecutive + 1},}`, "g")
  return text.replace(regex, "\n".repeat(maxConsecutive))
}

/**
 * Strips ANSI styling, cursor codes, OSC titles, and unwanted control sequences.
 * Preserves standard whitespace and readable text.
 */
export function stripAnsi(text: string): string {
  if (!text) return ""
  return text
    .replace(OSC_REGEX, "")
    .replace(ANSI_REGEX, "")
    .replace(CONTROL_CHAR_REGEX, "")
    .replace(/\r\n/g, "\n")
}

/**
 * Cleans command/terminal output:
 * - Strips ANSI escapes & OSC sequences
 * - Resolves carriage return overwrites & backspaces
 * - Removes non-printable control characters
 * - Trims trailing line whitespace
 * - Collapses excessive blank lines
 * - Trims outer empty lines
 */
export function cleanOutput(text: string): string {
  if (!text) return ""

  // 1. Strip OSC, ANSI, and control characters
  const stripped = stripAnsi(text)

  // 2. Resolve carriage returns & backspaces
  const resolved = resolveCarriageReturns(stripped)

  // 3. Clean line trailing whitespace and collapse excessive blank lines
  const cleaned = cleanLineWhitespace(resolved)
  return collapseBlankLines(cleaned, 2).trim()
}

/**
 * Smart output truncation to prevent agent context window explosion.
 * Preserves the beginning (head) and end (tail) of output with an informative omission notice.
 */
export const DEFAULT_MAX_OUTPUT_CHARS = 30000
export const DEFAULT_MAX_OUTPUT_LINES = 500

export interface TruncateResult {
  text: string
  truncated: boolean
  originalBytes: number
  originalLines: number
}

export function truncateOutput(
  text: string,
  maxChars: number = DEFAULT_MAX_OUTPUT_CHARS,
  maxLines: number = DEFAULT_MAX_OUTPUT_LINES
): TruncateResult {
  if (!text) {
    return { text: "", truncated: false, originalBytes: 0, originalLines: 0 }
  }

  const originalBytes = Buffer.byteLength(text, "utf-8")
  const lines = text.split("\n")
  const originalLines = lines.length

  if (text.length <= maxChars && lines.length <= maxLines) {
    return { text, truncated: false, originalBytes, originalLines }
  }

  const keepLines = Math.max(20, Math.min(150, Math.floor(maxLines / 2)))
  const head = lines.slice(0, keepLines)
  const tail = lines.slice(-keepLines)
  const omittedLines = originalLines - (head.length + tail.length)

  const headText = head.join("\n")
  const tailText = tail.join("\n")
  const omittedChars = text.length - (headText.length + tailText.length)

  const truncatedText = [
    headText,
    `\n... [output truncated: ${omittedLines > 0 ? `${omittedLines} lines, ` : ""}${omittedChars} chars omitted. Narrow with grep/head/tail] ...\n`,
    tailText,
  ].join("\n")

  return {
    text: truncatedText,
    truncated: true,
    originalBytes,
    originalLines,
  }
}

/**
 * Smart line-ending and whitespace-tolerant string matching for file editing:
 * 1. Exact match
 * 2. CRLF <-> LF normalized match (preserves original file newline style)
 * 3. Line-by-line trailing-whitespace-tolerant match
 */
export interface MatchAndReplaceResult {
  updatedContent: string
  replacements: number
}

export function smartEditMatchAndReplace(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean = false
): MatchAndReplaceResult {
  if (oldString === newString) {
    throw new Error("oldString and newString must differ.")
  }

  // 1. Verbatim exact match
  const exactCount = content.split(oldString).length - 1
  if (exactCount > 0) {
    if (exactCount > 1 && !replaceAll) {
      throw new Error(
        `oldString matched ${exactCount} times. Provide more surrounding context to match uniquely, or set replaceAll to true.`
      )
    }
    const updated = replaceAll
      ? content.split(oldString).join(newString)
      : content.replace(oldString, newString)
    return { updatedContent: updated, replacements: replaceAll ? exactCount : 1 }
  }

  // 2. Line ending normalization match (CRLF vs LF)
  const isCrlf = content.includes("\r\n")
  const normalizedContent = content.replace(/\r\n/g, "\n")
  const normalizedOld = oldString.replace(/\r\n/g, "\n")
  const normalizedNew = newString.replace(/\r\n/g, "\n")

  const normCount = normalizedContent.split(normalizedOld).length - 1
  if (normCount > 0) {
    if (normCount > 1 && !replaceAll) {
      throw new Error(
        `oldString matched ${normCount} times (after newline normalization). Provide more surrounding context to match uniquely, or set replaceAll to true.`
      )
    }

    const updatedNorm = replaceAll
      ? normalizedContent.split(normalizedOld).join(normalizedNew)
      : normalizedContent.replace(normalizedOld, normalizedNew)

    // Preserve original file line endings
    const finalContent = isCrlf ? updatedNorm.replace(/\n/g, "\r\n") : updatedNorm
    return { updatedContent: finalContent, replacements: replaceAll ? normCount : 1 }
  }

  // 3. Trailing line whitespace-tolerant match
  const contentLines = normalizedContent.split("\n")
  const oldLines = normalizedOld.split("\n")

  if (oldLines.length <= contentLines.length) {
    const trimmedOld = oldLines.map((l) => l.trimEnd())
    const matches: Array<{ startIndex: number; length: number }> = []

    for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
      let matched = true
      for (let j = 0; j < oldLines.length; j++) {
        if (contentLines[i + j].trimEnd() !== trimmedOld[j]) {
          matched = false
          break
        }
      }
      if (matched) {
        matches.push({ startIndex: i, length: oldLines.length })
      }
    }

    if (matches.length > 0) {
      if (matches.length > 1 && !replaceAll) {
        throw new Error(
          `oldString matched ${matches.length} times (ignoring trailing whitespace). Provide more surrounding context to match uniquely, or set replaceAll to true.`
        )
      }

      const replacementLines = normalizedNew.split("\n")
      const updatedLines = [...contentLines]
      const toReplace = replaceAll ? matches.slice().reverse() : [matches[0]]

      for (const m of toReplace) {
        updatedLines.splice(m.startIndex, m.length, ...replacementLines)
      }

      const updatedNorm = updatedLines.join("\n")
      const finalContent = isCrlf ? updatedNorm.replace(/\n/g, "\r\n") : updatedNorm
      return { updatedContent: finalContent, replacements: toReplace.length }
    }
  }

  throw new Error("oldString was not found.")
}

/**
 * Prunes undefined, null, and empty optional metadata strings from objects
 * to minimize token consumption in agent responses.
 */
export function pruneEmpty<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj
  if (Array.isArray(obj)) {
    return obj.map(pruneEmpty) as any
  }
  if (typeof obj === "object") {
    const result: any = {}
    for (const [key, value] of Object.entries(obj)) {
      if (value === undefined) continue
      // Prune empty optional metadata fields that waste tokens
      if (typeof value === "string" && value === "" && (key === "stderr" || key === "signal" || key === "details" || key === "hint")) {
        continue
      }
      result[key] = pruneEmpty(value)
    }
    return result
  }
  return obj
}
