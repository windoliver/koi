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
 * Build a unique info-notice payload for a context-engine swap. The `id`
 * captures the full identity transition (`turnId`, from, to, timestamp)
 * because hosts may issue multiple distinct swaps in the same turn (e.g.
 * `A→B`, `B→A`, then `A→B` again during repeated recovery). Earlier
 * versions deduped on `turnId + to`, which silently dropped exactly the
 * churn operators need to see.
 *
 * Idempotent re-dispatch of the SAME event still dedupes because every
 * field in the id is taken from the event itself.
 */
export function formatContextEngineSwapNotice(
  event: ContextEngineSwapEvent,
): ContextEngineSwapNotice {
  const fromTag = `${event.from.name}@${event.from.version}`;
  const toTag = `${event.to.name}@${event.to.version}`;
  const id = `info-context-engine-swap-${event.turnId}-${fromTag}-${toTag}-${event.timestamp}`;
  const message = `Context engine swapped: ${fromTag} → ${toTag} — ${event.reason}`;
  return { id, message };
}
