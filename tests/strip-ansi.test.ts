import { describe, it, expect } from "vitest"
import { stripAnsi } from "../src/strip-ansi.js"

describe("stripAnsi", () => {
  it("strips standard ANSI 16-color and 256-color escapes", () => {
    const raw = "\u001b[33m WARN\u001b[0m \u001b[2mshoumei::se\u001b[0m something happened"
    expect(stripAnsi(raw)).toBe(" WARN shoumei::se something happened")
  })

  it("strips complex terminal movement and clear sequences", () => {
    const raw = "\u001b[2K\u001b[1G\u001b[32mSuccess!\u001b[39m"
    expect(stripAnsi(raw)).toBe("Success!")
  })

  it("strips OSC sequences like titles and hyperlinks", () => {
    const raw = "\u001b]0;My Terminal Window\u0007Hello World"
    expect(stripAnsi(raw)).toBe("Hello World")
  })

  it("normalizes CRLF to LF", () => {
    const raw = "Line 1\r\nLine 2\r\nLine 3"
    expect(stripAnsi(raw)).toBe("Line 1\nLine 2\nLine 3")
  })
})
