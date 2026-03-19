/**
 * SQLite preset — single agent with SQLite persistence for system testing.
 * Lightweight preset designed for integration/system tests with durable state.
 */

import type { RuntimePreset } from "../types.js";

export const SQLITE_PRESET: RuntimePreset = {
  id: "sqlite",
  description: "Single agent with SQLite persistence for system testing",
  nexusMode: "embed-lite",
  services: {
    adminApi: true,
    tui: true,
    nexus: true,
    temporal: "disabled",
    gateway: false,
    node: "disabled",
  },
  defaultChannels: ["@koi/channel-cli"],
  defaultAddons: [],
  demoPack: undefined,
  stacks: {},
  manifestOverrides: {
    storage: { driver: "sqlite" },
  },
} as const;
