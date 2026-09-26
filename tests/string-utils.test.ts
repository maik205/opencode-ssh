import { describe, it, expect } from "vitest"
import {
  normalizeCommand,
  normalizePath,
  resolveCarriageReturns,
  cleanLineWhitespace,
  collapseBlankLines,
  cleanOutput,
  truncateOutput,
  smartEditMatchAndReplace,
  pruneEmpty,
} from "../src/string-utils.js"
import { successResult, errorResult } from "../src/agent-response.js"

describe("String & Whitespace Utilities", () => {
  describe("normalizeCommand", () => {
    it("strips UTF-8 BOM", () => {
      expect(normalizeCommand("\uFEFFecho 'hi'")).toBe("echo 'hi'")
    })

    it("converts CRLF and lone CR to standard Unix LF", () => {
      expect(normalizeCommand("cd /app\r\nnpm install\r\n")).toBe("cd /app\nnpm install")
      expect(normalizeCommand("line1\rline2")).toBe("line1\nline2")
    })

    it("trims outer whitespace while preserving internal indentation", () => {
      const script = `
  function test() {
    return 42
  }
`
      expect(normalizeCommand(script)).toBe("function test() {\n    return 42\n  }")
    })

    it("returns empty string for empty or whitespace-only input", () => {
      expect(normalizeCommand("   \n\t  ")).toBe("")
      expect(normalizeCommand("")).toBe("")
    })
  })

  describe("normalizePath", () => {
    it("trims whitespace and surrounding newlines", () => {
      expect(normalizePath("  /var/log/syslog\n ")).toBe("/var/log/syslog")
    })

    it("converts backslashes to forward slashes", () => {
      expect(normalizePath("var\\log\\nginx")).toBe("var/log/nginx")
    })
  })

  describe("resolveCarriageReturns & backspaces", () => {
    it("resolves terminal progress bar overwrites via carriage return", () => {
      const raw = "Progress: 10%\rProgress: 50%\rProgress: 100%"
      expect(resolveCarriageReturns(raw)).toBe("Progress: 100%")
    })

    it("takes the final overwritten frame when lines rewrite", () => {
      const raw = "Starting up...\rReady!"
      expect(resolveCarriageReturns(raw)).toBe("Ready!")
    })

    it("resolves terminal backspaces", () => {
      const raw = "abc\b\b12"
      expect(resolveCarriageReturns(raw)).toBe("a12")
    })
  })

  describe("cleanLineWhitespace & collapseBlankLines", () => {
    it("trims trailing spaces from lines while preserving leading indentation", () => {
      const raw = "    const x = 1;   \n  const y = 2;  \n"
      expect(cleanLineWhitespace(raw)).toBe("    const x = 1;\n  const y = 2;\n")
    })

    it("collapses runs of 3 or more blank lines down to 2", () => {
      const raw = "section 1\n\n\n\n\nsection 2"
      expect(collapseBlankLines(raw)).toBe("section 1\n\nsection 2")
    })
  })

  describe("cleanOutput", () => {
    it("performs full terminal cleanup: ANSI, carriage returns, trailing spaces, and blank lines", () => {
      const raw = "\u001b[32m[1/2] Compiling...\u001b[0m\r\u001b[32m[2/2] Done!\u001b[0m   \n\n\n\nOutput ready!  "
      expect(cleanOutput(raw)).toBe("[2/2] Done!\n\nOutput ready!")
    })
  })

  describe("truncateOutput", () => {
    it("leaves text untouched if within limits", () => {
      const res = truncateOutput("small output", 1000, 50)
      expect(res.truncated).toBe(false)
      expect(res.text).toBe("small output")
    })

    it("truncates large output, preserving head and tail with summary notice", () => {
      const lines = Array.from({ length: 600 }, (_, i) => `Line ${i + 1}`)
      const text = lines.join("\n")

      const res = truncateOutput(text, 5000, 100)
      expect(res.truncated).toBe(true)
      expect(res.text).toContain("Line 1")
      expect(res.text).toContain("Line 600")
      expect(res.text).toContain("output truncated:")
      expect(res.originalLines).toBe(600)
    })
  })

  describe("smartEditMatchAndReplace", () => {
    it("replaces exact matches verbatim", () => {
      const file = "const a = 1\nconst b = 2\n"
      const res = smartEditMatchAndReplace(file, "const a = 1", "const a = 10")
      expect(res.replacements).toBe(1)
      expect(res.updatedContent).toBe("const a = 10\nconst b = 2\n")
    })

    it("matches across CRLF and LF differences, preserving original CRLF convention", () => {
      const fileWithCrlf = "header\r\nvalue = 1\r\nfooter\r\n"
      // Agent sends search and replacement using Unix LF
      const oldStr = "value = 1"
      const newStr = "value = 2"

      const res = smartEditMatchAndReplace(fileWithCrlf, oldStr, newStr)
      expect(res.replacements).toBe(1)
      expect(res.updatedContent).toBe("header\r\nvalue = 2\r\nfooter\r\n")
      expect(res.updatedContent).toContain("\r\n")
    })

    it("matches multiline blocks even if file uses CRLF and agent sends LF", () => {
      const fileWithCrlf = "start\r\nline1\r\nline2\r\nend\r\n"
      const oldStr = "line1\nline2"
      const newStr = "line1_modified\nline2_modified"

      const res = smartEditMatchAndReplace(fileWithCrlf, oldStr, newStr)
      expect(res.replacements).toBe(1)
      expect(res.updatedContent).toBe("start\r\nline1_modified\r\nline2_modified\r\nend\r\n")
    })

    it("matches line-by-line ignoring trailing whitespace differences", () => {
      const fileWithTrailing = "function foo() {   \n  return true;  \n}\n"
      // Agent sends code without trailing spaces
      const oldStr = "function foo() {\n  return true;\n}"
      const newStr = "function bar() {\n  return false;\n}"

      const res = smartEditMatchAndReplace(fileWithTrailing, oldStr, newStr)
      expect(res.replacements).toBe(1)
      expect(res.updatedContent).toBe("function bar() {\n  return false;\n}\n")
    })

    it("throws if oldString matches multiple times without replaceAll", () => {
      const file = "foo\nfoo\n"
      expect(() => smartEditMatchAndReplace(file, "foo", "bar", false)).toThrow("matched 2 times")
    })

    it("replaces all occurrences when replaceAll is true", () => {
      const file = "foo\nfoo\n"
      const res = smartEditMatchAndReplace(file, "foo", "bar", true)
      expect(res.replacements).toBe(2)
      expect(res.updatedContent).toBe("bar\nbar\n")
    })

    it("throws if oldString is not found", () => {
      const file = "hello world\n"
      expect(() => smartEditMatchAndReplace(file, "missing", "found")).toThrow("oldString was not found")
    })
  })

  describe("Token Reduction & Agent Response Formatting", () => {
    it("prunes empty optional fields like empty stderr and undefined properties", () => {
      const payload = {
        stdout: "hello",
        stderr: "",
        exitCode: 0,
        signal: undefined,
        nested: {
          details: "",
          valid: 123,
        },
      }

      const pruned: any = pruneEmpty(payload)
      expect(pruned.stdout).toBe("hello")
      expect(pruned.exitCode).toBe(0)
      expect(pruned.stderr).toBeUndefined()
      expect(pruned.signal).toBeUndefined()
      expect(pruned.nested.details).toBeUndefined()
      expect(pruned.nested.valid).toBe(123)
    })

    it("formats success results compactly without bloated whitespace indentation", () => {
      const res = successResult({ count: 5, status: "ok" })
      expect(res.content).toBe('{"success":true,"count":5,"status":"ok"}')
      const parsed = JSON.parse(res.content)
      expect(parsed.success).toBe(true)
      expect(parsed.count).toBe(5)
    })

    it("formats error results cleanly without undefined fields", () => {
      const res = errorResult("ERR_TEST", "Something failed")
      expect(res.content).toBe('{"success":false,"error":{"code":"ERR_TEST","message":"Something failed"}}')
      const parsed = JSON.parse(res.content)
      expect(parsed.success).toBe(false)
      expect(parsed.error.code).toBe("ERR_TEST")
      expect(parsed.error.hint).toBeUndefined()
    })
  })
})
