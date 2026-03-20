/**
 * Koi TUI theme — color and style constants for OpenTUI components.
 *
 * Defines colors, style functions, and theme tokens used across views.
 * Pure data — no framework dependencies.
 */

import type { ConnectionStatus } from "./state/types.js";

// ─── Color Constants ─────────────────────────────────────────────────

/** Koi Deep Water palette. */
export const COLORS = {
  cyan: "#00CCCC",
  green: "#22C55E",
  yellow: "#EAB308",
  red: "#EF4444",
  blue: "#0088FF",
  magenta: "#FF00FF",
  white: "#E2E8F0",
  dim: "#8899AA",
  bg: "#001122",
  accent: "#FAF3DE",
  bgElevated: "#0D1B2A",
  bgSurface: "#1B2838",
  bgHover: "#2E3D4E",
  fgDim: "#4A5568",
  border: "#2E3D4E",
  borderSubtle: "#1B2838",
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
      return COLORS.fgDim;
  }
}
