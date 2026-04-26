import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: {
    compilerOptions: {
      composite: false,
    },
  },
  external: [/^@temporalio\//],
  clean: true,
  treeshake: true,
  target: "node22",
});
