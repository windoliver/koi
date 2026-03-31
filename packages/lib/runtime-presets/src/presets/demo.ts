/**
 * Demo preset — auth-enabled Nexus, auto-seeded demo data, TUI attached.
 * Designed for first-run operator experience.
 */

import type { RuntimePreset } from "../types.js";

export const DEMO_PRESET: RuntimePreset = {
  id: "demo",
  description: "Demo agent with auth-enabled Nexus, TUI, and seeded data",
  nexusMode: "embed-auth",
  services: {
    adminApi: true,
    tui: true,
    nexus: true,
    temporal: "auto",
    gateway: false,
    node: "disabled",
  },
  defaultChannels: ["@koi/channel-cli"],
  defaultAddons: [],
  demoPack: "connected",
  stacks: {
    forge: true,
    toolStack: true,
    retryStack: true,
    autoHarness: true,
    goalStack: true,
    qualityGate: true,
    contextHub: true,
    contextArena: true,
    threadStoreBackend: "nexus",
    ace: true,
    aceStoreBackend: "nexus",
    codeExecutor: true,
    governance: true,
    filesystem: true,
    rlmStack: true,
    dataSourceStack: true,
    sandboxStack: true,
  },
  manifestOverrides: {
    autonomous: { enabled: true },
    forge: { enabled: true },
    codeSandbox: { provider: "docker" },
  },
} as const;
