/**
 * @koi/channel-email — crash recovery for `reserving` outbox rows.
 *
 * Reservation order is outbox-first / thread-second (see
 * `outbound-state-machine.ts`), so a crash mid-reservation leaves an outbox
 * row in `reserving`. This scan reconciles each such row with the current
 * thread state and advances it to a terminal state:
 *
 *  - thread missing OR thread.version < outbox.threadVersion         → aborted
 *      (thread CAS never happened)
 *  - thread.version === outbox.threadVersion AND chain has messageId → awaiting-recovery
 *      (thread CAS landed but we crashed before SMTP attempt; operator decides)
 *  - thread.version > outbox.threadVersion                            → aborted
 *      (a later reservation has stacked on top — best-effort rollback to keep
 *       the chain consistent)
 *
 * Run on channel startup (before accepting new sends) and never concurrently
 * with `executeOutbound` for the same thread key.
 */

import type { OutboxStore, ThreadStore } from "@koi/channel-base";

export type RecoverDeps = {
  readonly outboxStore: OutboxStore;
  readonly threadStore: ThreadStore;
};

export type RecoverOutcome = "aborted" | "awaiting-recovery" | "no-op";

export type RecoverResult = {
  readonly messageId: string;
  readonly threadKey: string;
  readonly outcome: RecoverOutcome;
};

export async function recoverOrphanedReservations(
  deps: RecoverDeps,
): Promise<readonly RecoverResult[]> {
  const orphans = await deps.outboxStore.list({ status: "reserving" });
  const results: RecoverResult[] = [];
  for (const row of orphans) {
    const thread = await deps.threadStore.get(row.threadKey);
    const tv = thread?.version ?? 0;
    const chain = thread?.state.chain ?? [];
    const casLanded = tv === row.threadVersion && chain.includes(row.messageId);
    if (casLanded) {
      const ok = await deps.outboxStore.cas(row.messageId, "reserving", "awaiting-recovery");
      results.push({
        messageId: row.messageId,
        threadKey: row.threadKey,
        outcome: ok ? "awaiting-recovery" : "no-op",
      });
      continue;
    }
    // CAS never succeeded (or someone advanced past us); treat as aborted.
    // If a later reservation stacked on top with messageId in the chain,
    // best-effort strip it so the chain doesn't carry a phantom ancestor.
    if (chain.includes(row.messageId) && thread !== null) {
      const stripped = chain.filter((id) => id !== row.messageId);
      await deps.threadStore.cas(row.threadKey, tv, { chain: stripped });
    }
    const ok = await deps.outboxStore.cas(row.messageId, "reserving", "aborted");
    results.push({
      messageId: row.messageId,
      threadKey: row.threadKey,
      outcome: ok ? "aborted" : "no-op",
    });
  }
  return results;
}
