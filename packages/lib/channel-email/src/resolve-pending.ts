/**
 * @koi/channel-email — operator API for resolving awaiting-recovery sends.
 *
 * `getPendingSends()` lists every outbox row stuck in `awaiting-recovery`.
 * `resolvePending(messageId, outcome)` records the operator's decision:
 *   - "sent" → flips outbox row to `sent`; thread reservation stands.
 *   - "failed" → flips outbox row to `failed`, then best-effort rolls
 *      the Message-ID out of the thread chain. If a newer reservation
 *      has stacked on top, returns RECOVERY_CONFLICT.
 */

import type { OutboxRecord, OutboxStatus, OutboxStore, ThreadStore } from "@koi/channel-base";
import type { KoiError } from "./outbound-state-machine.js";

export type ResolveOutcome = "sent" | "failed";

export type ResolveResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: KoiError };

export type ResolveDeps = {
  readonly outboxStore: OutboxStore;
  readonly threadStore: ThreadStore;
};

export async function getPendingSends(deps: ResolveDeps): Promise<readonly OutboxRecord[]> {
  return deps.outboxStore.list({ status: "awaiting-recovery" });
}

const TERMINAL_STATUSES: ReadonlySet<OutboxStatus> = new Set([
  "sent",
  "aborted",
  "awaiting-recovery",
]);

function alreadyResolved(record: OutboxRecord, outcome: ResolveOutcome): ResolveResult {
  // Already in target terminal state with same outcome → idempotent ok.
  if (
    (outcome === "sent" && record.status === "sent") ||
    (outcome === "failed" && record.status === "aborted")
  ) {
    return { ok: true };
  }
  return {
    ok: false,
    error: {
      code: "ALREADY_RESOLVED",
      message: `outbox row already in terminal state '${record.status}'`,
      context: { messageId: record.messageId, currentStatus: record.status },
    },
  };
}

export async function resolvePending(
  deps: ResolveDeps,
  messageId: string,
  outcome: ResolveOutcome,
): Promise<ResolveResult> {
  const current = await deps.outboxStore.get(messageId);
  if (!current) {
    return {
      ok: false,
      error: {
        code: "ALREADY_RESOLVED",
        message: "outbox row not found",
        context: { messageId },
      },
    };
  }
  if (current.status !== "awaiting-recovery") {
    if (TERMINAL_STATUSES.has(current.status)) return alreadyResolved(current, outcome);
    return {
      ok: false,
      error: {
        code: "ALREADY_RESOLVED",
        message: `outbox row not in awaiting-recovery (status='${current.status}')`,
        context: { messageId, currentStatus: current.status },
      },
    };
  }

  if (outcome === "sent") {
    const ok = await deps.outboxStore.cas(messageId, "awaiting-recovery", "sent");
    if (!ok) {
      const after = await deps.outboxStore.get(messageId);
      if (after) return alreadyResolved(after, outcome);
    }
    return { ok: true };
  }

  // outcome === "failed"
  const flipped = await deps.outboxStore.cas(messageId, "awaiting-recovery", "aborted");
  if (!flipped) {
    const after = await deps.outboxStore.get(messageId);
    if (after) return alreadyResolved(after, outcome);
    return { ok: true };
  }

  // Best-effort thread rollback: only if no later reservation has stacked.
  const thread = await deps.threadStore.get(current.threadKey);
  if (!thread) return { ok: true };
  if (thread.version !== current.threadVersion) {
    return {
      ok: false,
      error: {
        code: "RECOVERY_CONFLICT",
        message: "operator must resolve later sends first",
        context: {
          messageId,
          expectedThreadVersion: current.threadVersion,
          actualThreadVersion: thread.version,
        },
      },
    };
  }
  const stripped = thread.state.chain.filter((id) => id !== messageId);
  await deps.threadStore.cas(current.threadKey, current.threadVersion, { chain: stripped });
  return { ok: true };
}
