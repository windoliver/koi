/**
 * Format a `ContextEngineSwapEvent` as a TUI-style info notice payload.
 *
 * Phase 6 of issue #1767. The TUI consumer subscribes to swap events on the
 * `EventComponent` bus and dispatches the returned `{ id, message }` shape as
 * a `kind: "info"` `TuiMessage` — which keeps the renderer compliant with
 * the single-writer output policy from #1940 (no direct stderr writes).
 *
 * This file is a pure formatter: no I/O, no store coupling. The boundary
 * with the TUI lives in the host that owns the store, not here.
 */

import type { ContextEngineSwapEvent } from "@koi/core";

/** Minimal payload — matches the `kind: "info"` TuiMessage variant in the TUI store. */
export interface ContextEngineSwapNotice {
  readonly id: string;
  readonly message: string;
}

/**
 * Build a stable info-notice payload for a context-engine swap. The `id` is
 * deterministic per `turnId + to-identity` so repeated dispatches dedupe
 * (TUI reducer drops duplicates by id).
 */
export function formatContextEngineSwapNotice(
  event: ContextEngineSwapEvent,
): ContextEngineSwapNotice {
  const id = `info-context-engine-swap-${event.turnId}-${event.to.name}@${event.to.version}`;
  const fromTag = `${event.from.name}@${event.from.version}`;
  const toTag = `${event.to.name}@${event.to.version}`;
  const message = `Context engine swapped: ${fromTag} → ${toTag} — ${event.reason}`;
  return { id, message };
}
