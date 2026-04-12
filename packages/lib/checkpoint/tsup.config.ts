import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  // bun:sqlite (transitive via @koi/snapshot-store-sqlite) is a Bun built-in.
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
