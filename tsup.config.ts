import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/index.ts", "src/tui.ts"],
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  external: ["@opencode/plugin", "@opencode/plugin/tui", "ssh2"]
})
