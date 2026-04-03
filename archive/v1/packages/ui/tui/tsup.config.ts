import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: {
    compilerOptions: {
      composite: false,
    },
  },
  external: ["@opentui/core", "@opentui/solid", "solid-js"],
  clean: true,
  treeshake: true,
  target: "node22",
  // SolidJS JSX transformation
  jsx: "preserve",
  esbuildOptions(options) {
    options.jsx = "automatic";
    options.jsxImportSource = "@opentui/solid";
  },
});
