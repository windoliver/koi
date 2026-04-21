import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: {
      compilerOptions: {
        composite: false,
      },
    },
    clean: true,
    treeshake: true,
    target: "node22",
  },
  {
    entry: ["src/worker-entry.ts"],
    format: ["esm"],
    dts: false,
    clean: false,
    treeshake: true,
    target: "node22",
  },
]);
