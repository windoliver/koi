/**
 * @koi/tui theme — v2 color tokens and layout helpers.
 *
 * Decision 6A: theme.ts contains only color tokens and primitive layout /
 * string helpers. Domain-specific status mappers (agent state, brick status)
 * belong in co-located component helpers, not here.
 *
 * Decision 16A: CONNECTION_STATUS_CONFIG is an as-const lookup table (not a
 * function) — zero allocation per lookup, compile-time exhaustiveness via
 * `satisfies Record<ConnectionStatus, ...>`.
 */

import type { ConnectionStatus, LayoutTier } from "./state/types.js";

// ---------------------------------------------------------------------------
// Color tokens
// ---------------------------------------------------------------------------

/** Koi Deep Water palette — semantic color constants. */
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
  // Component semantic colors (Tailwind-aligned)
  success: "#4ADE80",
  amber: "#FBBF24",
  danger: "#F87171",
  blueAccent: "#60A5FA",
  textSecondary: "#94A3B8",
  textMuted: "#64748B",
  purple: "#A78BFA",
} as const;

// ---------------------------------------------------------------------------
// Connection status
// ---------------------------------------------------------------------------

/**
 * Pre-computed indicator + color for each ConnectionStatus value.
 *
 * as-const lookup table: zero allocation per render, compile-time exhaustive.
 * Components index directly: `CONNECTION_STATUS_CONFIG[status].color`.
 */
export const CONNECTION_STATUS_CONFIG: Record<
  ConnectionStatus,
  { readonly indicator: string; readonly color: string }
> = {
  connected: { indicator: "● connected", color: COLORS.green },
  reconnecting: { indicator: "◌ reconnecting…", color: COLORS.yellow },
  disconnected: { indicator: "○ disconnected", color: COLORS.red },
};

// ---------------------------------------------------------------------------
// Modal positioning
// ---------------------------------------------------------------------------

/**
 * Shared absolute-position props for all modal overlays.
 * Apply to any modal's outer <box> to ensure consistent placement and z-stacking.
 */
export const MODAL_POSITION = {
  position: "absolute",
  top: 1,
  left: 2,
  zIndex: 20,
} as const;

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

/**
 * Compute layout tier from terminal column count.
 *
 * Breakpoints align with the StatusBar compact threshold (60 cols):
 *   < 60   → compact  (metrics hidden, minimal decoration)
 *   60-119 → normal   (standard layout)
 *   ≥ 120  → wide     (full layout)
 */
export function computeLayoutTier(cols: number): LayoutTier {
  if (cols >= 120) return "wide";
  if (cols >= 60) return "normal";
  return "compact";
}

/** Pad and truncate text to exactly `width` characters. */
export function truncate(text: string, width: number): string {
  return text.padEnd(width).slice(0, width);
}

/** Abbreviate a model name to its first character (e.g., "haiku-4.5" → "h"). */
export function abbreviateModel(model: string): string {
  const first = model[0];
  return first !== undefined ? first : "?";
}

/** Create a horizontal separator of `─` characters, capped at 80. */
export function separator(cols: number): string {
  return "─".repeat(Math.min(Math.max(cols - 2, 0), 80));
}
