import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/assembly.ts",
    "src/config.ts",
    "src/channel.ts",
    "src/common.ts",
    "src/context.ts",
    "src/delegation.ts",
    "src/ecs.ts",
    "src/engine.ts",
    "src/errors.ts",
    "src/hash.ts",
    "src/eviction.ts",
    "src/health.ts",
    "src/lifecycle.ts",
    "src/message.ts",
    "src/middleware.ts",
    "src/model-provider.ts",
    "src/resolver.ts",
    "src/brick-store.ts",
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
