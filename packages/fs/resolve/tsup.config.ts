import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/registry.ts",
    "src/resolve-manifest.ts",
    "src/register-companion-skills.ts",
    "src/register-bundled-agents.ts",
    "src/types.ts",
    "src/discover-static.ts",
  ],
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
