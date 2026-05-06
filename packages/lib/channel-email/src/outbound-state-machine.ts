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

async function isThreadBlocked(outboxStore: OutboxStore, threadKey: string): Promise<boolean> {
  // Block on `awaiting-recovery` (operator must resolve) AND on `aborting`
  // (resolver-owned intermediate during failed-resolution; brief, but a
  // racing send must not slip past a still-failing recovery).
  const [pending, aborting] = await Promise.all([
    outboxStore.list({ status: "awaiting-recovery" }),
    outboxStore.list({ status: "aborting" }),
  ]);
  return (
    pending.some((r) => r.threadKey === threadKey) ||
    aborting.some((r) => r.threadKey === threadKey)
  );
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
  if (await isThreadBlocked(deps.outboxStore, input.threadKey)) {
    return {
      ok: false,
      error: err(
        "THREAD_BLOCKED_PENDING_RECOVERY",
        "thread has unresolved awaiting-recovery sends; operator must resolve first",
        { threadKey: input.threadKey },
      ),
    };
  }

  const reserved = await reserveThread(deps, input);
  if (!reserved.ok) return reserved;
  const { messageId, threadVersion, priorThread } = reserved.value;

  // reserved → dispatching: explicit pre-SMTP-I/O phase marker. A row
  // stuck in `dispatching` after a crash is unambiguously "SMTP I/O not
  // yet observed", so recovery auto-aborts without forcing operator
  // intervention. We promote dispatching → sending only AFTER sendViaSmtp
  // has crossed into the post-DATA territory (returning post-data result).
  const dispatched = await deps.outboxStore.cas(messageId, "reserved", "dispatching");
  if (!dispatched) {
    return {
      ok: false,
      error: err("SEND_FAILED", "outbox CAS reserved→dispatching failed", { messageId }),
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
    // Pre-DATA failure → aborted + thread rollback (strip-by-id loop).
    await deps.outboxStore.cas(messageId, "dispatching", "aborted");
    await rollbackThread(deps.threadStore, input.threadKey, threadVersion, messageId);
    return {
      ok: false,
      error: err("SEND_FAILED", `pre-data failure: ${result.error}`, {
        messageId,
        phase: "pre-data",
      }),
    };
  }

  // We crossed into post-DATA territory: promote to `sending` so a future
  // crash before the terminal flip is correctly recovered as
  // awaiting-recovery (post-DATA outcome ambiguous), not auto-aborted.
  await deps.outboxStore.cas(messageId, "dispatching", "sending");

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
