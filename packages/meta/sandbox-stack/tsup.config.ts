import { defineConfig } from "tsup";

export default defineConfig({
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
  // Cloud sandbox backends are devDependencies — lazy-loaded via shims.
  // Mark external so tsup doesn't try to bundle their native deps.
  external: [
    "@koi/sandbox-cloudflare",
    "@koi/sandbox-daytona",
    "@koi/sandbox-docker",
    "@koi/sandbox-e2b",
    "@koi/sandbox-vercel",
  ],
});
