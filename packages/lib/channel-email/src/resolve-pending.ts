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
  //
  // Race-free single-owner protocol:
  //
  //   Step 1: CAS awaiting-recovery → aborting. This wins the resolver
  //           race: a concurrent "sent" resolver will see status=aborting
  //           and refuse, and a concurrent "failed" resolver will lose
  //           this CAS and return ALREADY_RESOLVED. Only after we own
  //           the row do we touch ThreadStore.
  //   Step 2: probe thread version; refuse with RECOVERY_CONFLICT (and
  //           leave the row in `aborting` for operator inspection) if a
  //           later send has stacked on top.
  //   Step 3: thread rollback CAS.
  //   Step 4: aborting → aborted (terminal).
  const claimed = await deps.outboxStore.cas(messageId, "awaiting-recovery", "aborting");
  if (!claimed) {
    const after = await deps.outboxStore.get(messageId);
    if (after) return alreadyResolved(after, outcome);
    return {
      ok: false,
      error: {
        code: "ALREADY_RESOLVED",
        message: "outbox row no longer awaiting-recovery",
        context: { messageId },
      },
    };
  }

  const thread = await deps.threadStore.get(current.threadKey);
  if (thread && thread.version !== current.threadVersion) {
    // Conflict: a later send has stacked on top. Revert the resolver-owned
    // intermediate so the row stays operator-visible (`awaiting-recovery`
    // is the state `getPendingSends()` lists and `executeOutbound` blocks
    // on). Leaving the row in `aborting` would silently unblock the
    // thread while the failed Message-ID is still in the chain.
    await deps.outboxStore.cas(messageId, "aborting", "awaiting-recovery").catch(() => {});
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

  if (thread) {
    const stripped = thread.state.chain.filter((id) => id !== messageId);
    const rolled = await deps.threadStore.cas(current.threadKey, current.threadVersion, {
      chain: stripped,
    });
    if (!rolled) {
      // Same conflict semantics: revert before surfacing.
      await deps.outboxStore.cas(messageId, "aborting", "awaiting-recovery").catch(() => {});
      return {
        ok: false,
        error: {
          code: "RECOVERY_CONFLICT",
          message: "operator must resolve later sends first",
          context: { messageId, threadKey: current.threadKey },
        },
      };
    }
  }

  const flipped = await deps.outboxStore.cas(messageId, "aborting", "aborted");
  if (!flipped) {
    const after = await deps.outboxStore.get(messageId);
    if (after) return alreadyResolved(after, outcome);
    return { ok: true };
  }
  return { ok: true };
}
