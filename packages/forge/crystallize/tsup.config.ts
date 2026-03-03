import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/auto-forge-middleware.ts", "src/pipeline-executor.ts"],
  format: ["esm"],
  dts: {
    compilerOptions: {
      composite: false,
    },
  },
  clean: true,
  treeshake: true,
  target: "node22",
});
