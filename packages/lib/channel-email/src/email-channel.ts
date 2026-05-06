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
  onNewMessage(cb: (env: InboundEnvelope) => void): () => void;
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

function envelopeKey(env: InboundEnvelope): string {
  return `${env.uidValidity}|${env.uid}`;
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
    if (!handler) return;
    await handler(normalized);
  };
}

const SEED_THREAD_CAS_RETRIES = 8;

async function seedInboundThread(
  threadStore: ThreadStore,
  threadKey: string,
  messageId: string,
): Promise<void> {
  // Bounded CAS-loop. Idempotent: if messageId is already in the chain (e.g.
  // duplicate webhook delivery, recovery replay), exit cleanly. Outbound
  // header derivation reads `threadStore.get(threadKey).chain` to build
  // `In-Reply-To`/`References`, so seeding here is what makes a normal
  // receive-then-reply flow thread-correctly without caller intervention.
  for (let i = 0; i < SEED_THREAD_CAS_RETRIES; i++) {
    const cur = await threadStore.get(threadKey);
    const v = cur?.version ?? 0;
    const chain = cur?.state.chain ?? [];
    if (chain.includes(messageId)) return;
    const ok = await threadStore.cas(threadKey, v, { chain: [...chain, messageId] });
    if (ok) return;
  }
}

async function enqueueInbound(
  deps: EmailDependencies,
  env: InboundEnvelope,
  clock: () => number,
): Promise<void> {
  const parsed = await deps.parser.parse(env.raw);
  const normalized = normalizeEmail(
    { parsed, imap: { uidValidity: env.uidValidity, uid: env.uid } },
    clock,
  );
  if (!normalized.ok) return; // drop unparseable
  const inboundMessageId = parsed.messageId;
  const threadKey = normalized.value.threadId;
  if (
    typeof inboundMessageId === "string" &&
    inboundMessageId.length > 0 &&
    typeof threadKey === "string" &&
    threadKey.length > 0
  ) {
    // Seed thread state BEFORE handler dispatch so reply-flows see the
    // inbound `Message-ID` in the chain. Best-effort: contention bail-out
    // is acceptable because the worst case is a degraded reply (unthreaded),
    // not corruption.
    await seedInboundThread(deps.threadStore, threadKey, inboundMessageId);
  }
  await deps.ingressQueue.enqueue(envelopeKey(env), {
    key: envelopeKey(env),
    payload: env,
    normalized: normalized.value,
  });
}

export function createEmailChannel(
  config: EmailConfig,
  deps: EmailDependencies,
): EmailChannelAdapter {
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
      await deps.imap.open();
      unsubscribeImap = deps.imap.onNewMessage((env) => {
        enqueueInbound(deps, env, clock).catch((err: unknown) => {
          // Surface the failure so the IMAP adapter can keep the message
          // un-acked / unread for retry on the next poll cycle. If the
          // caller has not provided an explicit handler, re-throw on a
          // microtask so the failure raises `unhandledRejection` telemetry
          // rather than disappearing silently.
          if (deps.onIngressError) {
            deps.onIngressError(err, env);
          } else {
            queueMicrotask(() => {
              throw err instanceof Error ? err : new Error(String(err));
            });
          }
        });
      });
      stopWorker = startHandlerWorker({
        queue: deps.ingressQueue,
        idempotencyStore: deps.idempotencyStore,
        handler: dispatchInbound(handlerRef),
        commitTtlMs: config.commitTtlMs,
        handlerTimeoutMs: config.handlerTimeoutMs,
        workerId: `email-${crypto.randomUUID()}`,
      });
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
