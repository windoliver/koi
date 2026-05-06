/**
 * @koi/channel-email — crash recovery for non-terminal outbox rows.
 *
 * After a crash the outbox can hold rows in non-terminal states.
 * Recovery distinguishes pre-SMTP intent from post-SMTP uncertainty:
 *
 *  - `reserving` (pre-SMTP, before reservation promotion)
 *      Row was never sent. Strip messageId from the thread chain (only
 *      if the thread CAS landed at this row's threadVersion) and abort.
 *
 *  - `reserved`  (pre-SMTP, after reservation promotion, before flip
 *                 to `sending`)
 *      Row was never sent. Strip from the thread chain and abort.
 *
 *  - `sending`   (durably persisted BEFORE the SMTP call returns; a
 *                 row in this state on restart means SMTP I/O may
 *                 have started or may have completed)
 *      Bytes may or may not have hit the wire — flip to
 *      `awaiting-recovery` and require an operator decision. Thread
 *      state is preserved (consistent with the post-DATA crash branch
 *      in `executeOutbound`). NEVER auto-abort: that risks rolling
 *      back a message the relay already accepted, which retries would
 *      then duplicate.
 *
 *  - `aborting` (resolver-owned intermediate)
 *      Resolver crashed mid-flight after CAS-claiming awaiting-recovery
 *      → aborting but before the terminal flip. Roll the chain back
 *      (idempotent) and complete the abort.
 *
 * Run once on channel `connect()` BEFORE accepting new sends, never
 * concurrently with `executeOutbound` for the same thread key.
 */

import type { OutboxRecord, OutboxStore, ThreadStore } from "@koi/channel-base";

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

async function rollbackThreadIfPresent(threadStore: ThreadStore, row: OutboxRecord): Promise<void> {
  // Bounded CAS-loop strip-by-id: an unsent `messageId` should not appear
  // at any thread version. Earlier behaviour bailed on version mismatch
  // which permanently leaked the id into newer chains. Stripping is
  // content-only repair; CAS still synchronises against concurrent
  // writers.
  for (let attempt = 0; attempt < 16; attempt++) {
    const thread = await threadStore.get(row.threadKey);
    if (thread === null) return;
    if (!thread.state.chain.includes(row.messageId)) return;
    const stripped = thread.state.chain.filter((id) => id !== row.messageId);
    const ok = await threadStore.cas(row.threadKey, thread.version, { chain: stripped });
    if (ok) return;
  }
}

async function abortPreSendRow(
  deps: RecoverDeps,
  row: OutboxRecord,
  expected: "reserving" | "reserved" | "aborting",
): Promise<RecoverResult> {
  await rollbackThreadIfPresent(deps.threadStore, row);
  const ok = await deps.outboxStore.cas(row.messageId, expected, "aborted");
  return {
    messageId: row.messageId,
    threadKey: row.threadKey,
    outcome: ok ? "aborted" : "no-op",
  };
}

export async function recoverOrphanedReservations(
  deps: RecoverDeps,
): Promise<readonly RecoverResult[]> {
  const results: RecoverResult[] = [];

  // Pre-SMTP: reserving and reserved rows were never handed to SMTP.
  for (const row of await deps.outboxStore.list({ status: "reserving" })) {
    results.push(await abortPreSendRow(deps, row, "reserving"));
  }
  for (const row of await deps.outboxStore.list({ status: "reserved" })) {
    results.push(await abortPreSendRow(deps, row, "reserved"));
  }
  // A resolver crashed mid-flight after CAS-claiming `awaiting-recovery →
  // aborting` but before the terminal flip. Roll the chain back if needed
  // (idempotent if the resolver already stripped it) and complete the
  // transition to `aborted`.
  for (const row of await deps.outboxStore.list({ status: "aborting" })) {
    results.push(await abortPreSendRow(deps, row, "aborting"));
  }

  // Post-SMTP intent: `sending` rows reached the SMTP layer but we did
  // not record the terminal outcome. Operator must decide.
  for (const row of await deps.outboxStore.list({ status: "sending" })) {
    const ok = await deps.outboxStore.cas(row.messageId, "sending", "awaiting-recovery");
    results.push({
      messageId: row.messageId,
      threadKey: row.threadKey,
      outcome: ok ? "awaiting-recovery" : "no-op",
    });
  }

  return results;
}
