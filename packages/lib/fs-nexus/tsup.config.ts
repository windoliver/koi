import { cpSync } from "node:fs";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/testing.ts"],
  external: ["bun:test"],
  format: ["esm"],
  dts: {
    compilerOptions: {
      composite: false,
    },
  },
  clean: true,
  treeshake: true,
  target: "node22",
  onSuccess: async () => {
    // Copy bridge.py to dist so createLocalTransport can find it
    // from both src/ (dev) and dist/ (built) contexts.
    cpSync("src/bridge.py", "dist/bridge.py");
  },
});
