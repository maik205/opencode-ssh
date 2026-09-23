/**
 * Utility to strip ANSI escape codes, terminal control sequences,
 * OSC sequences, and non-printable control characters from remote output.
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

// Additional unprintable control characters except standard whitespace (\n, \r, \t)
const CONTROL_CHAR_REGEX = /[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F-\u009F]/g

/**
 * Strips ANSI styling, cursor codes, OSC titles, and unwanted control sequences.
 * Preserves standard whitespace and readable UTF-8 text.
 */
export function stripAnsi(text: string): string {
  if (!text) return ""
  return text
    .replace(OSC_REGEX, "")
    .replace(ANSI_REGEX, "")
    .replace(CONTROL_CHAR_REGEX, "")
    .replace(/\r\n/g, "\n")
}
