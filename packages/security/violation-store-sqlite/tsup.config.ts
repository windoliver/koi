import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: {
    compilerOptions: {
      composite: false,
    },
  },
  external: ["bun:sqlite"],
  clean: true,
  treeshake: true,
  target: "node22",
});
