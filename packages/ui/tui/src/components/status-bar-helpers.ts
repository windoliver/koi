/**
 * Pure formatting helpers for StatusBar — exported as a plain .ts file so
 * tests can import them without triggering the JSX runtime (pre-existing
 * react/jsx-dev-runtime limitation in bun:test + @opentui/react).
 */

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatCost(costUsd: number | null): string {
  if (costUsd === null) return "—";
  if (costUsd < 0.01) return `$${costUsd.toFixed(4)}`;
  return `$${costUsd.toFixed(2)}`;
}
