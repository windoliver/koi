import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/workflows/agent-workflow.ts"],
  format: ["esm"],
  dts: {
    compilerOptions: {
      composite: false,
    },
  },
  clean: true,
  treeshake: true,
  target: "node22",
  external: [
    "@temporalio/workflow",
    "@temporalio/activity",
    "@temporalio/client",
    "@temporalio/worker",
    "@temporalio/common",
    "@temporalio/testing",
  ],
});
