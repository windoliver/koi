import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/bin.ts"],
  format: ["esm"],
  dts: {
    compilerOptions: {
      composite: false,
    },
  },
  clean: true,
  treeshake: true,
  target: "node22",
  // L3 stacks and gateway/node are dynamically imported at runtime
  // and must not be bundled — they may not be installed in all environments.
  external: [
    "@koi/tool-stack",
    "@koi/retry-stack",
    "@koi/auto-harness",
    "@koi/governance",
    "@koi/governance-memory",
    "@koi/context-arena",
    "@koi/goal-stack",
    "@koi/quality-gate",
    "@koi/sandbox-stack",
    "@koi/gateway-stack",
    "@koi/gateway",
    "@koi/node-stack",
  ],
});
