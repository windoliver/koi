/**
 * @koi/channel-base — production-mode durability guard.
 *
 * Channel factories with a `production: true` config flag must reject
 * non-durable in-memory store implementations. Restart-fragile dedupe
 * or routing state silently regresses to duplicate webhook processing
 * and `CONVERSATION_ADDRESS_UNKNOWN` outbound failures after a process
 * bounce, which production deployments cannot tolerate.
 */

import { InMemoryConversationAddressStore } from "./conversation-address-store.js";
import { InMemoryIdempotencyStore } from "./idempotency-store.js";
import { InMemoryIngressQueue } from "./ingress-queue.js";
import { InMemoryOutboxStore } from "./outbox-store.js";
import { InMemoryThreadStore } from "./thread-store.js";

export type ProductionGuardError = {
  readonly code: "INVALID_CONFIG";
  readonly message: string;
};

export type ProductionGuardResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: ProductionGuardError };

const IN_MEMORY_CTORS: ReadonlyArray<{ new (...args: never[]): unknown }> = [
  InMemoryIdempotencyStore,
  InMemoryIngressQueue,
  InMemoryOutboxStore,
  InMemoryThreadStore,
  InMemoryConversationAddressStore,
];

function isInMemory(store: unknown): boolean {
  return IN_MEMORY_CTORS.some((Ctor) => store instanceof Ctor);
}

/**
 * Throws if any of the named stores is an in-memory implementation while
 * `production` is true. Pass `{ name, store }` pairs in the order they
 * appear in the channel's dependency object so the error message names
 * the offender.
 */
export function assertDurableInProduction(
  production: boolean,
  stores: ReadonlyArray<{ readonly name: string; readonly store: unknown }>,
): ProductionGuardResult {
  if (!production) return { ok: true };
  const offenders = stores.filter((s) => isInMemory(s.store)).map((s) => s.name);
  if (offenders.length === 0) return { ok: true };
  return {
    ok: false,
    error: {
      code: "INVALID_CONFIG",
      message: `production mode requires durable stores; in-memory implementations supplied for: ${offenders.join(", ")}`,
    },
  };
}
