import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/state/index.ts",
    "src/bridge/permission-bridge.ts",
    "src/commands/slash-detection.ts",
    "src/components/index.ts",
  ],
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
