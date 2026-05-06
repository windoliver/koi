/**
 * @koi/channel-email — outbound state machine.
 *
 * Drives reservations across ThreadStore + OutboxStore + SmtpTransport with
 * CAS-only writes. States: reserved → sending → sent | aborted | awaiting-recovery.
 */

import type { OutboxStore, ThreadState, ThreadStore } from "@koi/channel-base";
import type { OutboundMessage } from "@koi/core";
import { formatOutbound } from "./format.js";
import { type SmtpTransport, sendViaSmtp } from "./platform-send.js";

export type EmailErrorCode =
  | "INVALID_CONFIG"
  | "AUTH_FAILED"
  | "CONNECTION_LOST"
  | "PARSE_FAILED"
  | "SEND_FAILED"
  | "UNSUPPORTED_TRANSPORT"
  | "THREAD_BLOCKED_PENDING_RECOVERY"
  | "THREAD_BUSY"
  | "RECOVERY_CONFLICT"
  | "ALREADY_RESOLVED";

export type KoiError = {
  readonly code: EmailErrorCode;
  readonly message: string;
  readonly retryable?: boolean;
  readonly context?: Readonly<Record<string, unknown>>;
};

export type Result<T, E = KoiError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export type OutboundDeps = {
  readonly threadStore: ThreadStore;
  readonly outboxStore: OutboxStore;
  readonly smtp: SmtpTransport;
  readonly idGenerator: () => string;
  readonly clock: () => number;
  readonly from: string;
};

export type OutboundInput = {
  readonly message: OutboundMessage;
  readonly threadKey: string;
  readonly to: readonly string[];
  readonly subject: string;
};

export type OutboundSuccess = {
  readonly messageId: string;
  readonly awaitingRecovery?: false;
};

const MAX_CAS_RETRIES = 16;

function err(
  code: EmailErrorCode,
  message: string,
  ctx?: Readonly<Record<string, unknown>>,
): KoiError {
  return ctx ? { code, message, context: ctx } : { code, message };
}

const IN_FLIGHT_OUTBOX_STATUSES: ReadonlySet<string> = new Set([
  "reserving",
  "reserved",
  "sending",
]);

async function threadBlockReason(
  outboxStore: OutboxStore,
  threadKey: string,
): Promise<"awaiting-recovery" | "in-flight" | null> {
  // Block on `awaiting-recovery` (operator must resolve) AND on `aborting`
  // (resolver-owned intermediate during failed-resolution; brief, but a
  // racing send must not slip past a still-failing recovery). Also block
  // on any in-flight predecessor (`reserving` / `reserved` / `sending`):
  // a tentative Message-ID is visible in the thread chain after
  // reservation, so a concurrent second send would derive
  // In-Reply-To/References from a parent that may yet be rolled back on
  // pre-DATA failure — leaving a sent reply pointing at a Message-ID
  // that never existed. Single in-flight send per thread is the only
  // safe rule given the chain-derivation contract.
  const [pending, aborting, reserving, reserved, sending] = await Promise.all([
    outboxStore.list({ status: "awaiting-recovery" }),
    outboxStore.list({ status: "aborting" }),
    outboxStore.list({ status: "reserving" }),
    outboxStore.list({ status: "reserved" }),
    outboxStore.list({ status: "sending" }),
  ]);
  if (
    pending.some((r) => r.threadKey === threadKey) ||
    aborting.some((r) => r.threadKey === threadKey)
  ) {
    return "awaiting-recovery";
  }
  if (
    reserving.some((r) => r.threadKey === threadKey) ||
    reserved.some((r) => r.threadKey === threadKey) ||
    sending.some((r) => r.threadKey === threadKey)
  ) {
    return "in-flight";
  }
  return null;
}

type Reservation = {
  readonly messageId: string;
  readonly threadVersion: number;
  /** The thread state stored after reservation (includes this message-id). */
  readonly thread: ThreadState;
  /** The thread state visible to outbound headers (prior chain, excludes this id). */
  readonly priorThread: ThreadState;
};

/**
 * Reservation order is **outbox-first, thread-second** to eliminate the
 * orphaned-thread-reservation crash window:
 *
 *   1. Write outbox row as `reserving` (durable intent, threadVersion = v+1)
 *   2. CAS thread chain v -> v+1 to include messageId
 *   3a. CAS success: outbox `reserving` -> `reserved`
 *   3b. CAS contention: outbox `reserving` -> `aborted`, retry with same messageId
 *
 * If the process crashes between (1) and (2) the outbox carries a `reserving`
 * row whose threadVersion does not match the thread store; recovery is
 * straightforward via `recoverOrphanedReservations`. The opposite ordering
 * (advance thread first) leaves the thread chain holding a phantom
 * messageId with no outbox row, which is not recoverable from the stores'
 * public API (ThreadStore has no list method).
 */
async function reserveThread(
  deps: OutboundDeps,
  input: OutboundInput,
): Promise<Result<Reservation>> {
  const messageId = deps.idGenerator();
  const payloadHash = hashPayload(input);
  const createdAt = deps.clock();
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
    const current = await deps.threadStore.get(input.threadKey);
    const currentVersion = current?.version ?? 0;
    const currentChain = current?.state.chain ?? [];
    // Atomic-ish in-flight check: if the latest chain entry corresponds
    // to a non-terminal outbox row, refuse the reservation. Both the
    // chain read AND the outbox status query are on consistent
    // pre-CAS state — and any concurrent reservation that lands AFTER
    // this read will still lose its threadStore.cas (version
    // contention), so the second send cannot derive headers from a
    // tentative parent that gets rolled back. This complements the
    // outer `threadBlockReason` precheck for races between calls.
    if (currentChain.length > 0) {
      const lastId = currentChain[currentChain.length - 1] ?? "";
      const lastRow = await deps.outboxStore.get(lastId);
      if (lastRow !== null && IN_FLIGHT_OUTBOX_STATUSES.has(lastRow.status)) {
        return {
          ok: false,
          error: err(
            "THREAD_BUSY",
            "thread has an in-flight predecessor; serialize sends per thread to avoid header derivation atop tentative Message-IDs",
            { threadKey: input.threadKey, predecessor: lastId },
          ),
        };
      }
    }
    const nextVersion = currentVersion + 1;
    const nextChain: readonly string[] = [...currentChain, messageId];
    const nextState: ThreadState = { chain: nextChain };
    // (1) Durable intent record. On the first attempt this is a put; on a
    // retry it overwrites the previous attempt's `aborted` row with a fresh
    // `reserving` at the new threadVersion.
    await deps.outboxStore.put({
      messageId,
      threadKey: input.threadKey,
      threadVersion: nextVersion,
      payloadHash,
      status: "reserving",
      createdAt,
    });
    const ok = await deps.threadStore.cas(input.threadKey, currentVersion, nextState);
    if (ok) {
      const promoted = await deps.outboxStore.cas(messageId, "reserving", "reserved");
      if (!promoted) {
        return {
          ok: false,
          error: err("SEND_FAILED", "outbox CAS reserving→reserved failed", { messageId }),
        };
      }
      return {
        ok: true,
        value: {
          messageId,
          threadVersion: nextVersion,
          thread: nextState,
          priorThread: { chain: currentChain },
        },
      };
    }
    // CAS lost: cancel the intent so a recovery scan does not see a stale row.
    await deps.outboxStore.cas(messageId, "reserving", "aborted");
  }
  return {
    ok: false,
    error: err("SEND_FAILED", "thread CAS contention exceeded retry budget", {
      threadKey: input.threadKey,
    }),
  };
}

async function rollbackThread(
  threadStore: ThreadStore,
  threadKey: string,
  _expectedVersion: number,
  messageId: string,
): Promise<void> {
  // Strip the unsent `messageId` from the chain via a bounded CAS loop.
  // Earlier behaviour bailed when the thread version had advanced, which
  // permanently leaked the unsent id into the ancestry of every future
  // reply. Removing a known-unsent id from any chain version is a
  // content-only repair: there is no version at which the id legitimately
  // belongs, and CAS still synchronises us against concurrent writers.
  for (let attempt = 0; attempt < 16; attempt++) {
    const current = await threadStore.get(threadKey);
    if (!current) return;
    if (!current.state.chain.includes(messageId)) return; // someone already stripped it
    const stripped = current.state.chain.filter((id) => id !== messageId);
    const ok = await threadStore.cas(threadKey, current.version, { chain: stripped });
    if (ok) return;
  }
}

function hashPayload(input: OutboundInput): string {
  // Cheap stable hash — content kinds + lengths + thread key. Not cryptographic.
  const parts = input.message.content.map((b) =>
    b.kind === "text" ? `t:${b.text.length}` : `${b.kind}`,
  );
  return `${input.threadKey}|${input.subject}|${parts.join(",")}`;
}

export async function executeOutbound(
  deps: OutboundDeps,
  input: OutboundInput,
): Promise<Result<OutboundSuccess>> {
  const blockReason = await threadBlockReason(deps.outboxStore, input.threadKey);
  if (blockReason === "awaiting-recovery") {
    return {
      ok: false,
      error: err(
        "THREAD_BLOCKED_PENDING_RECOVERY",
        "thread has unresolved awaiting-recovery sends; operator must resolve first",
        { threadKey: input.threadKey },
      ),
    };
  }
  if (blockReason === "in-flight") {
    return {
      ok: false,
      error: err(
        "THREAD_BUSY",
        "thread has an in-flight send; serialize sends per thread to avoid header derivation atop tentative Message-IDs",
        { threadKey: input.threadKey },
      ),
    };
  }

  const reserved = await reserveThread(deps, input);
  if (!reserved.ok) return reserved;
  const { messageId, threadVersion, priorThread } = reserved.value;

  // reserved → sending: persist the post-I/O-uncertain state BEFORE
  // calling sendViaSmtp. A crash mid-call leaves the row in `sending`,
  // which crash recovery promotes to `awaiting-recovery` for operator
  // resolution — never auto-aborted. The earlier "dispatching" marker
  // attempted to mark "I/O not yet started" but the durable write
  // happened on entry to that state, before the actual SMTP call: a
  // process crash between `cas reserved→dispatching` and the post-call
  // `cas dispatching→sending` could leave a row that had ALREADY
  // written DATA stuck in `dispatching`, which recovery would then
  // auto-abort and incorrectly retry, causing duplicate delivery. The
  // fix: state is `sending` from before the SMTP call, and pre-DATA
  // failures (returned synchronously) flip sending→aborted with
  // thread rollback as before.
  const dispatched = await deps.outboxStore.cas(messageId, "reserved", "sending");
  if (!dispatched) {
    return {
      ok: false,
      error: err("SEND_FAILED", "outbox CAS reserved→sending failed", { messageId }),
    };
  }

  // Build envelope and send via SMTP.
  const envelope = formatOutbound({
    message: input.message,
    thread: priorThread,
    outboundMessageId: messageId,
    from: deps.from,
    to: input.to,
    subject: input.subject,
  });
  const result = await sendViaSmtp(deps.smtp, envelope);

  if (result.phase === "pre-data") {
    // Pre-DATA failure (sync return → no DATA bytes written). Safe to
    // flip sending→aborted and roll back the thread chain.
    await deps.outboxStore.cas(messageId, "sending", "aborted");
    await rollbackThread(deps.threadStore, input.threadKey, threadVersion, messageId);
    return {
      ok: false,
      error: err("SEND_FAILED", `pre-data failure: ${result.error}`, {
        messageId,
        phase: "pre-data",
      }),
    };
  }

  if (result.phase === "post-data" && result.ok) {
    const ok = await deps.outboxStore.cas(messageId, "sending", "sent");
    if (!ok) {
      return {
        ok: false,
        error: err("SEND_FAILED", "outbox CAS sending→sent failed", { messageId }),
      };
    }
    return { ok: true, value: { messageId } };
  }

  // Post-DATA failure → awaiting-recovery; thread state stays advanced.
  await deps.outboxStore.cas(messageId, "sending", "awaiting-recovery");
  return {
    ok: false,
    error: err(
      "SEND_FAILED",
      `post-data uncertain: ${result.ok ? "ok" : result.error}; awaiting operator resolution`,
      { messageId, phase: "post-data", awaitingRecovery: true },
    ),
  };
}
