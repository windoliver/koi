import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/bin.ts", "src/index.ts"],
  format: ["esm"],
  dts: {
    compilerOptions: {
      composite: false,
    },
  },
  clean: true,
  treeshake: true,
  target: "node22",
  // Bundle all @koi/* workspace packages into the output so the published CLI
  // is self-contained. Third-party runtime deps (solid-js, @opentui/*) stay
  // external — they're listed in dependencies and installed by npm/bun.
  noExternal: [/@koi\/.*/],
  // bun:* built-ins cannot be bundled by esbuild — they are resolved natively
  // at runtime by Bun. This became necessary when @koi/session (which uses
  // bun:sqlite) was added as a transitive dep of @koi/runtime.
  external: ["bun:sqlite"],
});
