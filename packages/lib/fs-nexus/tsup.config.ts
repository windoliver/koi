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
});
