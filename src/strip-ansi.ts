/**
 * Backward compatibility re-export.
 * Core string and terminal cleanup logic has been consolidated in ./string-utils.js.
 */
export {
  stripAnsi,
  cleanOutput,
  resolveCarriageReturns,
  cleanLineWhitespace,
  collapseBlankLines,
  normalizeCommand,
  normalizePath,
  truncateOutput,
  smartEditMatchAndReplace,
  pruneEmpty,
} from "./string-utils.js"
