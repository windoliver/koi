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
  // L2 channel packages are devDependencies — consumers add the ones they need.
  // Mark them external so tsup doesn't try to bundle native deps (ffmpeg, livekit, etc.)
  external: [
    "@koi/channel-cli",
    "@koi/channel-slack",
    "@koi/channel-discord",
    "@koi/channel-telegram",
    "@koi/channel-teams",
    "@koi/channel-email",
    "@koi/channel-matrix",
    "@koi/channel-signal",
    "@koi/channel-whatsapp",
    "@koi/channel-voice",
    "@koi/channel-mobile",
    "@koi/channel-canvas-fallback",
    "@koi/channel-chat-sdk",
    "@koi/channel-agui",
  ],
});
