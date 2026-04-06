import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  external: ["bun:sqlite"],
  dts: {
    compilerOptions: {
      composite: false,
    },
  },
  clean: true,
  treeshake: true,
  target: "node22",
});
