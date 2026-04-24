import type {
  AgentId,
  AgentMessage,
  AgentMessageInput,
  JsonObject,
  KoiError,
  MailboxComponent,
  MessageFilter,
  Result,
} from "@koi/core";
import { messageId, RETRYABLE_DEFAULTS } from "@koi/core";
import type { LocalMailboxConfig, LocalMailboxInstance, MailboxRouter } from "./types.js";

const DEFAULT_MAX_MESSAGES = 10_000;

// Single-copy note: @koi/ipc-local requires exactly one loaded copy per process.
// Duplicate copies are detected naturally at router.register() time — a mailbox created
// by copy B will not be in copy A's deliveryFunctions WeakMap and will throw with a
// clear error message. No separate startup sentinel is needed; the WeakMap check is the
// authoritative guard and only fires when unsafe cross-copy routing is actually attempted.

// Identity brand stamped on every mailbox created by createLocalMailbox.
// Symbol.for() is used so the brand key is stable across serialization/inspection tools,
// but isLocalMailboxInstance also requires WeakMap membership (deliveryFunctions below),
// so this brand alone grants no routing privilege. Both checks are same-module-instance:
// the duplicate-load guard above ensures there is only one module instance per process,
// so WeakMap identity is reliable for all registered mailboxes.
const LOCAL_MAILBOX_BRAND = Symbol.for("@koi/ipc-local/local-mailbox");

// Internal routing-path seal: only messages submitted via the delivery function are trusted.
// The WeakSet holds cloned AgentMessageInput references added by the routing path
// before the inbound send() call, proving origin without modifying the input shape.
const routedInputs = new WeakSet<AgentMessageInput>();

// Module-private WeakMap: mailbox instance → authenticated delivery function.
// Stored outside the mailbox object so it is NOT discoverable via reflection
// (Object.getOwnPropertySymbols, Object.keys, Reflect.ownKeys, etc.).
// Only code within this module can call a mailbox's delivery function.
type DeliverFn = (
  input: AgentMessageInput,
  senderMailbox: MailboxComponent,
) => Promise<Result<AgentMessage, KoiError>>;
const deliveryFunctions = new WeakMap<object, DeliverFn>();

// Module-private WeakMap: mailbox instance → the router it was bound to at creation.
// createLocalMailboxRouter uses this to reject registration of mailboxes bound to a
// different router (or no router), preventing inbound-auth gaps from routerless mailboxes.
const mailboxRouterBinding = new WeakMap<object, MailboxRouter | undefined>();

/**
 * Returns true when `mailbox` was created with `router` as its bound router.
 * Used by createLocalMailboxRouter to enforce that only mailboxes explicitly
 * created for this router instance can be registered in it.
 */
export function isMailboxBoundToRouter(mailbox: object, router: MailboxRouter): boolean {
  return mailboxRouterBinding.get(mailbox) === router;
}

// Module-private registry: maps each MailboxRouter to its registered mailbox instances.
// Populated by recordMailboxRegistration / cleared by clearMailboxRegistration (called by
// createLocalMailboxRouter). Used for internal delivery lookups and identity checks so that
// router.getView() can return a restricted MailboxView without exposing send() to callers.
const routerRegistrations = new WeakMap<MailboxRouter, Map<string, LocalMailboxInstance>>();

/**
 * Records a mailbox registration in the module-private registry.
 * Called by createLocalMailboxRouter.register() — not part of the public API.
 */
export function recordMailboxRegistration(
  router: MailboxRouter,
  agentId: AgentId,
  mailbox: LocalMailboxInstance,
): void {
  let map = routerRegistrations.get(router);
  if (map === undefined) {
    map = new Map();
    routerRegistrations.set(router, map);
  }
  map.set(agentId, mailbox);
}

/**
 * Removes a mailbox registration from the module-private registry.
 * Called by createLocalMailboxRouter.unregister() — not part of the public API.
 */
export function clearMailboxRegistration(router: MailboxRouter, agentId: AgentId): void {
  routerRegistrations.get(router)?.delete(agentId);
}

function getRegisteredMailbox(
  router: MailboxRouter,
  agentId: AgentId,
): LocalMailboxInstance | undefined {
  return routerRegistrations.get(router)?.get(agentId);
}

/**
 * Returns true when `mailbox` was produced by createLocalMailbox in this module instance.
 * Checks the Symbol.for brand (stable key for inspector/tooling use) AND the module-private
 * deliveryFunctions WeakMap (the actual auth gate). Both checks are same-module-instance:
 * a mailbox from a duplicate copy of this package will fail the WeakMap check even if it
 * carries the global brand. Duplicate-package deployments are not supported.
 */
export function isLocalMailboxInstance(mailbox: MailboxComponent): mailbox is LocalMailboxInstance {
  return LOCAL_MAILBOX_BRAND in (mailbox as object) && deliveryFunctions.has(mailbox);
}

function deepFreeze(obj: JsonObject): JsonObject {
  if (Object.isFrozen(obj)) return obj;
  Object.freeze(obj);
  for (const value of Object.values(obj)) {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
      deepFreeze(value as JsonObject);
    }
  }
  return obj;
}

function safeCloneFreeze(
  field: "payload" | "metadata",
  value: JsonObject,
): Result<JsonObject, KoiError> {
  try {
    return { ok: true, value: deepFreeze(structuredClone(value)) };
  } catch (e: unknown) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Message ${field} is not serializable: ${e instanceof Error ? e.message : String(e)}`,
        retryable: false,
        context: { field },
      },
    };
  }
}

export function createLocalMailbox(config: LocalMailboxConfig): LocalMailboxInstance {
  const rawMax = config.maxMessages ?? DEFAULT_MAX_MESSAGES;
  if (!Number.isInteger(rawMax) || rawMax < 1) {
    throw new Error(`createLocalMailbox: maxMessages must be a positive integer, got ${rawMax}`);
  }
  const maxMessages = rawMax;
  const messages: AgentMessage[] = [];
  const subscribers = new Set<(message: AgentMessage) => void | Promise<void>>();
  // let rather than const: both are explicitly mutable state
  let closed = false;
  // Bumped by drain() and close() to cancel any pending microtask deliveries,
  // preventing duplicate processing when callers drain/close before dispatch fires.
  let generation = 0;
  // Self-reference used in the delivery function and close() unregister check.
  let self: LocalMailboxInstance | undefined;

  function safeOnError(err: unknown, msg: AgentMessage): void {
    try {
      config.onError?.(err, msg);
    } catch {
      // Observer itself threw — swallow to preserve isolation
    }
  }

  // Dispatches to the subscriber snapshot captured at send time, routing any errors
  // to onError rather than propagating — isolation is preserved for all other handlers.
  function dispatchToSnapshot(
    snapshot: ReadonlySet<(message: AgentMessage) => void | Promise<void>>,
    msg: AgentMessage,
  ): void {
    for (const handler of snapshot) {
      try {
        const result = handler(msg);
        if (result instanceof Promise) {
          result.catch((err: unknown) => {
            safeOnError(err, msg);
          });
        }
      } catch (err: unknown) {
        safeOnError(err, msg);
      }
    }
  }

  self = {
    get agentId(): AgentId {
      return config.agentId;
    },

    async send(input: AgentMessageInput): Promise<Result<AgentMessage, KoiError>> {
      if (closed) {
        return {
          ok: false,
          error: {
            code: "INTERNAL",
            message: "Mailbox is closed",
            retryable: false,
            context: { agentId: config.agentId },
          },
        };
      }

      // Self-addressed messages with a router: route through the delivery function so
      // the same routing-token proof used for cross-agent sends applies uniformly.
      // routedInputs.has(input) is false on the first call (pre-token) and true on the
      // recursive call after the delivery function stamps the envelope — that prevents
      // an infinite loop while ensuring auth is never bypassed.
      //
      // Security boundary: the mailbox object IS the self-send capability. Any caller who
      // holds a mailbox reference can enqueue self-addressed messages for that agent. The
      // protection against external self-send injection is that the router's getView()
      // intentionally hides send() — callers must obtain the full mailbox to self-send.
      // The cross-agent forgery guard (routing-token proof + sender-registration check)
      // remains unaffected: a holder of mailboxA cannot forge messages appearing to come
      // from mailboxA to mailboxB; self-send injection only affects the holder's own queue.
      if (input.to === config.agentId && config.router !== undefined && !routedInputs.has(input)) {
        if (input.from !== config.agentId) {
          return {
            ok: false,
            error: {
              code: "PERMISSION",
              message: `Cannot forge sender identity: outbound messages must have from=${config.agentId}`,
              retryable: false,
              context: { agentId: config.agentId, attemptedFrom: input.from },
            },
          };
        }
        const deliverSelf = deliveryFunctions.get(self!);
        if (deliverSelf !== undefined) {
          return deliverSelf(input, self!);
        }
      }

      // Cross-agent delivery: route via injected router, or reject if none.
      if (input.to !== config.agentId) {
        // Reject forged sender — only the mailbox owner may originate outbound messages.
        if (input.from !== config.agentId) {
          return {
            ok: false,
            error: {
              code: "PERMISSION",
              message: `Cannot forge sender identity: outbound messages must have from=${config.agentId}`,
              retryable: false,
              context: { agentId: config.agentId, attemptedFrom: input.from },
            },
          };
        }
        if (config.router !== undefined) {
          // Use internal registry rather than the public router.getView() (which returns a
          // restricted MailboxView without send()) to obtain the full delivery target.
          const fullTarget = getRegisteredMailbox(config.router, input.to);
          if (fullTarget === undefined) {
            return {
              ok: false,
              error: {
                code: "NOT_FOUND",
                message: `No mailbox registered for agent ${input.to}`,
                retryable: false,
                context: { agentId: input.to },
              },
            };
          }
          // Look up the target's delivery function from the module-private WeakMap.
          // This is the only path that can add a routing token to routedInputs,
          // and it is not accessible via reflection on the target mailbox object.
          const deliverToTarget = deliveryFunctions.get(fullTarget);
          if (deliverToTarget !== undefined) {
            return deliverToTarget(input, self!);
          }
          return fullTarget.send(input);
        }
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `No router configured; cannot deliver to ${input.to}`,
            retryable: false,
            context: { agentId: input.to },
          },
        };
      }

      // Inbound sender authentication when a router is present.
      // All inbound messages must carry a routing token stamped by the module-private
      // delivery function. Self-sends (from === agentId) skip the "sender registered?"
      // check — the delivery function already verified senderMailbox === self, which is
      // sufficient proof without needing the mailbox to be registered yet.
      if (config.router !== undefined) {
        if (
          input.from !== config.agentId &&
          getRegisteredMailbox(config.router, input.from) === undefined
        ) {
          return {
            ok: false,
            error: {
              code: "PERMISSION",
              message: `Inbound messages must come from registered agents; sender ${input.from} is not in the router`,
              retryable: false,
              context: { agentId: config.agentId, attemptedFrom: input.from },
            },
          };
        }
        if (!routedInputs.has(input)) {
          return {
            ok: false,
            error: {
              code: "PERMISSION",
              message: `Cross-agent delivery must use the internal routing path; direct send() is rejected to prevent sender impersonation`,
              retryable: false,
              context: { agentId: config.agentId, attemptedFrom: input.from },
            },
          };
        }
        routedInputs.delete(input); // one-shot: consume the routing token
      }

      // Reject when at capacity — explicit backpressure instead of silent eviction.
      // Retryable: capacity frees once drain() is called or subscribers retire messages.
      if (messages.length >= maxMessages) {
        return {
          ok: false,
          error: {
            code: "RESOURCE_EXHAUSTED",
            message: `Mailbox capacity exceeded (maxMessages=${maxMessages}). Process queued messages or contact an administrator to free capacity.`,
            retryable: RETRYABLE_DEFAULTS.RESOURCE_EXHAUSTED,
            context: { agentId: config.agentId, capacity: maxMessages },
          },
        };
      }

      // Deep-clone then deep-freeze payload/metadata — surface clone errors as Result.
      const payloadResult = safeCloneFreeze("payload", input.payload);
      if (!payloadResult.ok) return payloadResult;

      let metadata: JsonObject | undefined;
      if (input.metadata !== undefined) {
        const metaResult = safeCloneFreeze("metadata", input.metadata);
        if (!metaResult.ok) return metaResult;
        metadata = metaResult.value;
      }

      const msg: AgentMessage = Object.freeze({
        id: messageId(crypto.randomUUID()),
        createdAt: new Date().toISOString(),
        from: input.from,
        to: input.to,
        kind: input.kind,
        type: input.type,
        payload: payloadResult.value,
        ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
        ...(input.ttlSeconds !== undefined ? { ttlSeconds: input.ttlSeconds } : {}),
        ...(metadata !== undefined ? { metadata } : {}),
      });

      messages.push(msg);
      // Snapshot subscribers at accept time so only handlers present during send()
      // receive this message — late subscribes and mid-flight unsubscribes are excluded.
      const snapshot = new Set(subscribers);
      const gen = generation;
      // Decouple delivery from the send() call stack via microtask to prevent
      // re-entrant delivery loops when subscribers send cross-agent messages.
      queueMicrotask(() => {
        // drain() or close() bumps generation — bail out to prevent duplicate processing.
        if (generation !== gen) return;
        dispatchToSnapshot(snapshot, msg);
      });

      return { ok: true, value: msg };
    },

    onMessage(handler: (message: AgentMessage) => void | Promise<void>): () => void {
      if (closed) return () => {};
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },

    list(filter?: MessageFilter): readonly AgentMessage[] {
      if (closed) return [];
      const result: AgentMessage[] = [];
      for (const msg of messages) {
        if (filter?.limit !== undefined && result.length >= filter.limit) break;
        if (filter?.kind !== undefined && msg.kind !== filter.kind) continue;
        if (filter?.type !== undefined && msg.type !== filter.type) continue;
        if (filter?.from !== undefined && msg.from !== filter.from) continue;
        result.push(msg);
      }
      return result;
    },

    drain(): readonly AgentMessage[] {
      // Cancel any pending microtask deliveries before returning the cleared messages,
      // ensuring drained messages cannot also be delivered to subscribers.
      generation++;
      const dropped = [...messages];
      messages.length = 0;
      return dropped;
    },

    close(): void {
      // Cancel pending deliveries before teardown to prevent post-close subscriber calls.
      generation++;
      closed = true;
      messages.length = 0;
      subscribers.clear();
      // Only unregister if the internal registry still points to this instance — prevents
      // a stale close() from evicting a live replacement registered after us.
      if (
        config.router !== undefined &&
        getRegisteredMailbox(config.router, config.agentId) === self
      ) {
        config.router.unregister(config.agentId);
      }
    },
  };

  // Store the authenticated delivery function in the module-private WeakMap.
  // Security design:
  // - Not on the mailbox object → not discoverable via Object.getOwnPropertySymbols/Reflect.ownKeys
  // - Clone is marked in routedInputs, not the original → prevents replay by the caller
  // - Sender identity verified via module-private routerRegistrations (not the public router.getView())
  // - WeakSet entry is consumed (deleted) on first use inside send()
  deliveryFunctions.set(self, async (input, senderMailbox) => {
    // Self-sends: senderMailbox === self proves the call came from this mailbox's own send().
    // No router registration is required — the instance identity check is sufficient.
    // Cross-agent sends: verify the sender is the registered instance for input.from.
    const isSelfSend = senderMailbox === self;
    if (
      !isSelfSend &&
      (config.router === undefined ||
        senderMailbox !== getRegisteredMailbox(config.router, input.from))
    ) {
      return {
        ok: false,
        error: {
          code: "PERMISSION",
          message: `Sender identity mismatch: claimed from=${input.from} but actual sender instance differs`,
          retryable: false,
          context: { agentId: config.agentId, attemptedFrom: input.from },
        },
      };
    }
    const envelope: AgentMessageInput = { ...input };
    routedInputs.add(envelope);
    return self!.send(envelope);
  });

  // Stamp the cross-instance brand as a non-enumerable, non-configurable property.
  // Symbol.for() ensures the same symbol is used across duplicate package copies so
  // isLocalMailboxInstance works in version-skew and workspace-dedup scenarios.
  // The brand alone grants no routing privilege — deliveryFunctions WeakMap gates auth.
  Object.defineProperty(self, LOCAL_MAILBOX_BRAND, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  // Record the router this mailbox was created with so createLocalMailboxRouter can
  // verify ownership at registration time and reject routerless or cross-router mailboxes.
  mailboxRouterBinding.set(self, config.router);

  return self;
}

// LocalMailboxInstance is defined in types.ts and re-exported from index.ts.
