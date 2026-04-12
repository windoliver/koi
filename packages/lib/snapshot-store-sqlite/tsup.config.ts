import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  // bun:sqlite is a Bun built-in — esbuild can't resolve it, so mark external.
  external: ["bun:sqlite"],
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
