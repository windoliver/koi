/**
 * Koi TUI theme — color and style constants for OpenTUI components.
 *
 * Defines colors, style functions, and theme tokens used across views.
 * Pure data — no framework dependencies.
 */

import type { ConnectionStatus } from "./state/types.js";

// ─── Color Constants ─────────────────────────────────────────────────

/** Koi brand colors. */
export const COLORS = {
  cyan: "#00CCCC",
  green: "#00FF00",
  yellow: "#FFFF00",
  red: "#FF0000",
  blue: "#0088FF",
  magenta: "#FF00FF",
  white: "#FFFFFF",
  dim: "#888888",
  bg: "#001122",
} as const;

// ─── Status Indicators ──────────────────────────────────────────────

/** Connection status indicator config. */
export function connectionStatusConfig(status: ConnectionStatus): {
  readonly indicator: string;
  readonly color: string;
} {
  switch (status) {
    case "connected":
      return { indicator: "● connected", color: COLORS.green };
    case "reconnecting":
      return { indicator: "◌ reconnecting…", color: COLORS.yellow };
    case "disconnected":
      return { indicator: "○ disconnected", color: COLORS.red };
  }
}

/** Agent process state color. */
export function agentStateColor(
  state: "created" | "running" | "waiting" | "suspended" | "idle" | "terminated",
): string {
  switch (state) {
    case "created":
      return COLORS.blue;
    case "running":
      return COLORS.green;
    case "waiting":
      return COLORS.yellow;
    case "idle":
      return COLORS.cyan;
    case "suspended":
      return COLORS.magenta;
    case "terminated":
      return COLORS.dim;
  }
}
