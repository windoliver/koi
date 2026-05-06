/**
 * @koi/channel-email — outbound state machine.
 *
 * Drives reservations across ThreadStore + OutboxStore + SmtpTransport with
 * CAS-only writes. States: reserved → sending → sent | aborted | awaiting-recovery.
 */

import type { OutboxRecord, OutboxStore, ThreadState, ThreadStore } from "@koi/channel-base";
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
  const pending = await outboxStore.list({ status: "awaiting-recovery" });
  return pending.some((r) => r.threadKey === threadKey);
}

type Reservation = {
  readonly messageId: string;
  readonly threadVersion: number;
  /** The thread state stored after reservation (includes this message-id). */
  readonly thread: ThreadState;
  /** The thread state visible to outbound headers (prior chain, excludes this id). */
  readonly priorThread: ThreadState;
};

async function reserveThread(deps: OutboundDeps, threadKey: string): Promise<Result<Reservation>> {
  const messageId = deps.idGenerator();
  // CAS-loop retry — bounded to avoid pathological infinite loops.
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
    const current = await deps.threadStore.get(threadKey);
    const currentVersion = current?.version ?? 0;
    const currentChain = current?.state.chain ?? [];
    const nextChain: readonly string[] = [...currentChain, messageId];
    const nextState: ThreadState = { chain: nextChain };
    const ok = await deps.threadStore.cas(threadKey, currentVersion, nextState);
    if (ok) {
      return {
        ok: true,
        value: {
          messageId,
          threadVersion: currentVersion + 1,
          thread: nextState,
          priorThread: { chain: currentChain },
        },
      };
    }
  }
  return {
    ok: false,
    error: err("SEND_FAILED", "thread CAS contention exceeded retry budget", {
      threadKey,
    }),
  };
}

async function rollbackThread(
  threadStore: ThreadStore,
  threadKey: string,
  expectedVersion: number,
  messageId: string,
): Promise<void> {
  const current = await threadStore.get(threadKey);
  if (!current) return;
  if (current.version !== expectedVersion) return; // someone else advanced — leave alone
  const stripped = current.state.chain.filter((id) => id !== messageId);
  await threadStore.cas(threadKey, expectedVersion, { chain: stripped });
}

async function writeOutbox(
  outboxStore: OutboxStore,
  reservation: Reservation,
  threadKey: string,
  payloadHash: string,
  createdAt: number,
): Promise<void> {
  const record: OutboxRecord = {
    messageId: reservation.messageId,
    threadKey,
    threadVersion: reservation.threadVersion,
    payloadHash,
    status: "reserved",
    createdAt,
  };
  await outboxStore.put(record);
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

  const reserved = await reserveThread(deps, input.threadKey);
  if (!reserved.ok) return reserved;
  const { messageId, threadVersion, priorThread } = reserved.value;

  await writeOutbox(
    deps.outboxStore,
    reserved.value,
    input.threadKey,
    hashPayload(input),
    deps.clock(),
  );

  // reserved → sending
  const flipped = await deps.outboxStore.cas(messageId, "reserved", "sending");
  if (!flipped) {
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

  if (result.phase === "pre-data") {
    // Pre-DATA failure → aborted + best-effort thread rollback.
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
