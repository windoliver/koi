/**
 * Local preset — single agent, local Nexus embed, no auth.
 * This is the default preset for `koi init`.
 */

import type { RuntimePreset } from "../types.js";

export const LOCAL_PRESET: RuntimePreset = {
  id: "local",
  description: "Single agent with local Nexus (no auth, fastest startup)",
  nexusMode: "embed-lite",
  services: {
    adminApi: true,
    tui: false,
    nexus: true,
    temporal: "disabled",
    gateway: false,
    node: "disabled",
  },
  defaultChannels: ["@koi/channel-cli"],
  defaultAddons: [],
  demoPack: undefined,
  stacks: {},
  manifestOverrides: {},
} as const;
