/**
 * @koi/channel-email — `createEmailChannel` factory.
 *
 * Composes IMAP inbound + SMTP outbound into a `ChannelAdapter`. The factory
 * is a small wiring layer: state-machine logic lives in
 * `outbound-state-machine.ts`, operator API in `resolve-pending.ts`. This
 * module only handles lifecycle (connect/disconnect), inbound dedupe via
 * IngressQueue + IdempotencyStore, and the `send()` adapter shim.
 */

import {
  assertDurableInProduction,
  type IdempotencyStore,
  type IngressQueue,
  type OutboxRecord,
  type OutboxStore,
  startHandlerWorker,
  type ThreadStore,
} from "@koi/channel-base";
import type {
  ChannelAdapter,
  ChannelCapabilities,
  InboundMessage,
  MessageHandler,
  OutboundMessage,
} from "@koi/core";
import type { EmailConfig } from "./config.js";
import { type MimeParser, normalizeEmail } from "./normalize-bridge.js";
import { executeOutbound } from "./outbound-state-machine.js";
import type { SmtpTransport } from "./platform-send.js";
import { recoverOrphanedReservations } from "./recover-orphans.js";
import {
  getPendingSends,
  type ResolveOutcome,
  type ResolveResult,
  resolvePending,
} from "./resolve-pending.js";

export type InboundEnvelope = {
  readonly raw: Uint8Array;
  readonly uidValidity: number;
  readonly uid: number;
};

export interface ImapClient {
  open(): Promise<void>;
  close(): Promise<void>;
  /**
   * Subscribe to new mailbox messages. The callback returns a Promise that
   * resolves ONLY after the channel has durably enqueued the message; the
   * IMAP adapter MUST treat callback rejection as a signal to keep the
   * message un-acked / unread so a future poll cycle redelivers it.
   * Acknowledging (or advancing the cursor) before the callback resolves
   * loses messages on transient parser/store failures.
   */
  onNewMessage(cb: (env: InboundEnvelope) => Promise<void>): () => void;
}

export type { MimeParser } from "./normalize-bridge.js";

export type EmailDependencies = {
  readonly imap: ImapClient;
  readonly smtp: SmtpTransport;
  readonly parser: MimeParser;
  readonly threadStore: ThreadStore;
  readonly outboxStore: OutboxStore;
  readonly idempotencyStore: IdempotencyStore;
  readonly ingressQueue: IngressQueue<InboundEnvelope, InboundMessage>;
  readonly idGenerator?: () => string;
  readonly clock?: () => number;
  /**
   * REQUIRED for production. Invoked when inbound MIME parsing, thread
   * seeding, or queue persistence fails. The IMAP adapter MUST use this
   * signal to keep the message un-acked / unread so a future poll cycle
   * retries it. The default implementation re-throws on a microtask so
   * the failure surfaces via `unhandledRejection` telemetry — silent
   * drop is never the default.
   */
  readonly onIngressError?: (error: unknown, envelope: InboundEnvelope) => void;
};

export type EmailChannelAdapter = ChannelAdapter & {
  readonly getPendingSends: () => Promise<readonly OutboxRecord[]>;
  readonly resolvePending: (messageId: string, outcome: ResolveOutcome) => Promise<ResolveResult>;
};

const EMAIL_CAPABILITIES: ChannelCapabilities = {
  text: true,
  images: false,
  files: false,
  buttons: false,
  audio: false,
  video: false,
  threads: true,
  supportsA2ui: false,
};

function defaultIdGenerator(domain: string): () => string {
  return () => `<${crypto.randomUUID()}@${domain}>`;
}

function envelopeKey(config: EmailConfig, env: InboundEnvelope): string {
  // Scope dedupe by mailbox identity: durable stores shared across multiple
  // inboxes can collide on UIDVALIDITY|UID, which is only mailbox-unique.
  const { host, user, mailbox } = config.imap;
  return `${host}|${user}|${mailbox}|${env.uidValidity}|${env.uid}`;
}

function deriveDomain(from: string): string {
  const at = from.indexOf("@");
  return at >= 0 ? from.slice(at + 1) : "agent.local";
}

type HandlerRef = { current: MessageHandler | null };

function dispatchInbound(handlerRef: HandlerRef): (
  item: {
    readonly key: string;
    readonly payload: InboundEnvelope;
    readonly normalized: InboundMessage;
  },
  signal: AbortSignal,
) => Promise<void> {
  return async ({ normalized }, signal) => {
    if (signal.aborted) return;
    const handler = handlerRef.current;
    if (handler === null) {
      // No onMessage handler installed yet. Throw so the worker
      // nacks (with retry / eventual deadLetter) instead of
      // committing the message and acking the IMAP source — silent
      // null-handler success would lose user mail without trace.
      throw new Error(
        "NO_HANDLER: onMessage() handler not installed; cannot dispatch inbound message",
      );
    }
    await handler(normalized);
  };
}

const SEED_THREAD_CAS_RETRIES = 8;

async function seedInboundThread(
  threadStore: ThreadStore,
  threadKey: string,
  messageId: string,
): Promise<boolean> {
  // Bounded CAS-loop. Idempotent: if messageId is already in the chain (e.g.
  // duplicate webhook delivery, recovery replay), exit cleanly. Outbound
  // header derivation reads `threadStore.get(threadKey).chain` to build
  // `In-Reply-To`/`References`, so seeding here is what makes a normal
  // receive-then-reply flow thread-correctly without caller intervention.
  // Returns false if the CAS bound is exhausted; caller must treat that
  // as an ingress failure (silent return would let an unthreaded reply
  // ship and break recovery semantics).
  for (let i = 0; i < SEED_THREAD_CAS_RETRIES; i++) {
    const cur = await threadStore.get(threadKey);
    const v = cur?.version ?? 0;
    const chain = cur?.state.chain ?? [];
    if (chain.includes(messageId)) return true;
    const ok = await threadStore.cas(threadKey, v, { chain: [...chain, messageId] });
    if (ok) return true;
  }
  return false;
}

async function enqueueInbound(
  config: EmailConfig,
  deps: EmailDependencies,
  env: InboundEnvelope,
  clock: () => number,
): Promise<void> {
  const parsed = await deps.parser.parse(env.raw);
  const normalized = normalizeEmail(
    { parsed, imap: { uidValidity: env.uidValidity, uid: env.uid } },
    clock,
  );
  if (!normalized.ok) {
    // Surface unparseable mail as an explicit error rather than a silent
    // drop. The IMAP adapter sees the rejected callback and keeps the
    // message un-acked / unread; an operator (or `onIngressError` hook)
    // decides whether to dead-letter or wait for a parser fix. Silent
    // drop on parse regressions = permanent inbound mail loss.
    throw new Error(`PARSE_FAILED: ${normalized.error.message}`, {
      cause: normalized.error,
    });
  }
  const inboundMessageId = parsed.messageId;
  const threadKey = normalized.value.threadId;
  if (
    typeof inboundMessageId === "string" &&
    inboundMessageId.length > 0 &&
    typeof threadKey === "string" &&
    threadKey.length > 0
  ) {
    // Seed thread state BEFORE handler dispatch so reply-flows see the
    // inbound `Message-ID` in the chain. CAS bound exhaustion is rare
    // but real under high contention; treat it as ingress failure so
    // the IMAP adapter keeps the message un-acked and retries on the
    // next poll, rather than dispatching a message whose chain entry
    // never landed (which would silently produce unthreaded replies
    // and break recovery semantics).
    const seeded = await seedInboundThread(deps.threadStore, threadKey, inboundMessageId);
    if (!seeded) {
      throw new Error(
        `THREAD_SEED_CAS_EXHAUSTED: failed to add ${inboundMessageId} to thread ${threadKey} after ${SEED_THREAD_CAS_RETRIES} attempts`,
      );
    }
  }
  const key = envelopeKey(config, env);
  await deps.ingressQueue.enqueue(key, {
    key,
    payload: env,
    normalized: normalized.value,
  });
  // Block the IMAP callback on terminal handler outcome so the IMAP
  // adapter does NOT acknowledge / advance its cursor until the user
  // handler has succeeded (or the message has been dead-lettered, which
  // we surface as an error so the adapter can keep the message un-acked
  // for operator triage). Without this, a handler crash after enqueue
  // would leave no provider-side redelivery surface.
  const drain = await deps.ingressQueue.awaitDrain(key);
  if (!drain.ok) {
    throw new Error(`HANDLER_DEAD_LETTERED: ${drain.details}`);
  }
}

export function createEmailChannel(
  config: EmailConfig,
  deps: EmailDependencies,
): EmailChannelAdapter {
  const guard = assertDurableInProduction(config.production, [
    { name: "idempotencyStore", store: deps.idempotencyStore },
    { name: "ingressQueue", store: deps.ingressQueue },
    { name: "threadStore", store: deps.threadStore },
    { name: "outboxStore", store: deps.outboxStore },
  ]);
  if (!guard.ok) {
    throw new Error(`${guard.error.code}: ${guard.error.message}`);
  }
  const clock = deps.clock ?? Date.now;
  const idGenerator = deps.idGenerator ?? defaultIdGenerator(deviceDomain(config));
  const handlerRef: HandlerRef = { current: null };

  // Lifecycle handles, captured by connect()/disconnect().
  let unsubscribeImap: (() => void) | null = null;
  let stopWorker: (() => Promise<void>) | null = null;
  let connected = false;

  const adapter: EmailChannelAdapter = {
    name: "email",
    capabilities: EMAIL_CAPABILITIES,

    connect: async () => {
      if (connected) return;
      // Reconcile any `reserving` outbox rows left over from a prior crash
      // BEFORE accepting new sends, so the operator's pending list and the
      // thread store agree on what is in-flight.
      await recoverOrphanedReservations({
        outboxStore: deps.outboxStore,
        threadStore: deps.threadStore,
      });
      // Start the handler worker BEFORE subscribing to IMAP. The
      // onNewMessage callback awaits ingressQueue.awaitDrain, which
      // requires a running worker to resolve; if an IMAP adapter
      // synchronously delivers already-pending mail during
      // subscription registration, a worker started AFTER
      // onNewMessage would never run because connect() blocks on
      // the callback's awaitDrain. Worker first → subscription
      // second → IMAP open last guarantees the consumer is live
      // when the producer wakes up.
      stopWorker = startHandlerWorker({
        queue: deps.ingressQueue,
        idempotencyStore: deps.idempotencyStore,
        handler: dispatchInbound(handlerRef),
        commitTtlMs: config.commitTtlMs,
        handlerTimeoutMs: config.handlerTimeoutMs,
        workerId: `email-${crypto.randomUUID()}`,
      });
      unsubscribeImap = deps.imap.onNewMessage(async (env) => {
        try {
          await enqueueInbound(config, deps, env, clock);
        } catch (err: unknown) {
          // Surface for telemetry, then re-throw so the IMAP adapter keeps
          // the message un-acked / unread for redelivery. The `await` in
          // this callback is the contract that lets the adapter gate
          // mailbox acknowledgement on durable enqueue success.
          deps.onIngressError?.(err, env);
          throw err;
        }
      });
      await deps.imap.open();
      connected = true;
    },

    disconnect: async () => {
      if (!connected) return;
      unsubscribeImap?.();
      unsubscribeImap = null;
      const stop = stopWorker;
      stopWorker = null;
      if (stop) await stop();
      await deps.imap.close();
      connected = false;
    },

    send: async (message: OutboundMessage) => {
      // v1 rejects multi-recipient sends. Partial SMTP acceptance
      // (some recipients accepted, some rejected) has no safe message-
      // level resolution: marking the outbox sent loses the rejected
      // subset; marking it failed rolls back thread state for accepted
      // recipients who already saw the message. Per-recipient state is
      // future work; until then we fail closed at the boundary so
      // callers cannot silently produce mixed-delivery outcomes.
      const meta = message.metadata ?? {};
      const toRaw = meta.to;
      const recipientCount = Array.isArray(toRaw)
        ? toRaw.filter((x): x is string => typeof x === "string").length
        : typeof toRaw === "string"
          ? 1
          : 0;
      if (recipientCount > 1) {
        throw new Error(
          `MULTI_RECIPIENT_UNSUPPORTED: v1 email channel accepts a single recipient per send (got ${recipientCount}). Send one message per recipient until per-recipient delivery state is implemented.`,
        );
      }
      const result = await executeOutbound(
        {
          threadStore: deps.threadStore,
          outboxStore: deps.outboxStore,
          smtp: deps.smtp,
          idGenerator,
          clock,
          from: config.smtp.from,
        },
        deriveSendInput(message, config.smtp.from),
      );
      if (!result.ok) {
        throw new Error(`${result.error.code}: ${result.error.message}`, {
          cause: result.error,
        });
      }
    },

    onMessage: (handler: MessageHandler) => {
      handlerRef.current = handler;
      return () => {
        if (handlerRef.current === handler) handlerRef.current = null;
      };
    },

    getPendingSends: () =>
      getPendingSends({
        outboxStore: deps.outboxStore,
        threadStore: deps.threadStore,
      }),

    resolvePending: (messageId, outcome) =>
      resolvePending(
        { outboxStore: deps.outboxStore, threadStore: deps.threadStore },
        messageId,
        outcome,
      ),
  };

  return adapter;
}

function deviceDomain(config: EmailConfig): string {
  return deriveDomain(config.smtp.from);
}

function deriveSendInput(
  message: OutboundMessage,
  fromAddress: string,
): {
  readonly message: OutboundMessage;
  readonly threadKey: string;
  readonly to: readonly string[];
  readonly subject: string;
} {
  const meta = message.metadata ?? {};
  const threadKey =
    typeof message.threadId === "string" && message.threadId.length > 0
      ? message.threadId
      : typeof meta.threadKey === "string"
        ? meta.threadKey
        : `<orphan-${crypto.randomUUID()}@${deriveDomain(fromAddress)}>`;
  const toRaw = meta.to;
  const to: readonly string[] = Array.isArray(toRaw)
    ? toRaw.filter((x): x is string => typeof x === "string")
    : typeof toRaw === "string"
      ? [toRaw]
      : [];
  const subject = typeof meta.subject === "string" ? meta.subject : "";
  return { message, threadKey, to, subject };
}
