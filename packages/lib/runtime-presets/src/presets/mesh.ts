/**
 * Mesh preset — multi-agent with gateway, node, Temporal, full Nexus.
 * For production-like multi-agent topologies.
 */

import type { RuntimePreset } from "../types.js";

export const MESH_PRESET: RuntimePreset = {
  id: "mesh",
  description: "Multi-agent mesh with gateway, node, and Temporal orchestration",
  nexusMode: "embed-auth",
  services: {
    adminApi: true,
    tui: true,
    nexus: true,
    temporal: "auto",
    gateway: true,
    node: "full",
  },
  defaultChannels: ["@koi/channel-cli"],
  defaultAddons: [],
  demoPack: undefined,
  manifestOverrides: {
    autonomous: { enabled: true },
  },
} as const;
