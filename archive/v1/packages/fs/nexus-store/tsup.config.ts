import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/ace.ts",
    "src/forge.ts",
    "src/events.ts",
    "src/snapshots.ts",
    "src/session.ts",
    "src/memory.ts",
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
