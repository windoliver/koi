/**
 * Cursor-based query for events between two cursors.
 *
 * Walks the snapshot chain to find relevant TurnTrace nodes
 * and filters events by cursor range.
 */

import type {
  ChainId,
  EventCursor,
  KoiError,
  Result,
  SessionId,
  SnapshotChainStore,
  TraceEvent,
  TurnTrace,
} from "@koi/core";

/**
 * Retrieves all trace events between two cursors (inclusive).
 * Walks the snapshot chain to find relevant TurnTrace nodes.
 * When sessionId is provided, only nodes belonging to that session are included,
 * preventing contamination from overlapping sessions on the same chainId.
 */
export async function getEventsBetween(
  store: SnapshotChainStore<TurnTrace>,
  chainId: ChainId,
  from: EventCursor,
  to: EventCursor,
  sessionId?: SessionId,
): Promise<Result<readonly TraceEvent[], KoiError>> {
  const listResult = await store.list(chainId);
  if (!listResult.ok) {
    return listResult;
  }

  const nodes = listResult.value;

  // Collect events from turns in the cursor range, scoped to session
  const collected: TraceEvent[] = [];
  for (const node of nodes) {
    // Skip nodes belonging to other sessions
    if (sessionId !== undefined && node.data.sessionId !== sessionId) {
      continue;
    }

    const turnIndex = node.data.turnIndex;
    if (turnIndex < from.turnIndex || turnIndex > to.turnIndex) {
      continue;
    }

    for (const event of node.data.events) {
      const include = shouldIncludeEvent(event, turnIndex, from, to);
      if (include) {
        collected.push(event);
      }
    }
  }

  // Sort by (turnIndex, eventIndex) ascending
  const sorted = [...collected].sort((a, b) => {
    if (a.turnIndex !== b.turnIndex) {
      return a.turnIndex - b.turnIndex;
    }
    return a.eventIndex - b.eventIndex;
  });

  return { ok: true, value: sorted };
}

function shouldIncludeEvent(
  event: TraceEvent,
  turnIndex: number,
  from: EventCursor,
  to: EventCursor,
): boolean {
  // Same turn as both from and to
  if (turnIndex === from.turnIndex && turnIndex === to.turnIndex) {
    return event.eventIndex >= from.eventIndex && event.eventIndex <= to.eventIndex;
  }
  // Same turn as from only
  if (turnIndex === from.turnIndex) {
    return event.eventIndex >= from.eventIndex;
  }
  // Same turn as to only
  if (turnIndex === to.turnIndex) {
    return event.eventIndex <= to.eventIndex;
  }
  // Between from and to turns — include all
  return true;
}
