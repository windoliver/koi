/**
 * @koi/channel-base — production-mode durability guard.
 *
 * Channel factories with a `production: true` config flag must reject
 * non-durable in-memory store implementations. Restart-fragile dedupe
 * or routing state silently regresses to duplicate webhook processing
 * and `CONVERSATION_ADDRESS_UNKNOWN` outbound failures after a process
 * bounce, which production deployments cannot tolerate.
 */

export type ProductionGuardError = {
  readonly code: "INVALID_CONFIG";
  readonly message: string;
};

export type ProductionGuardResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: ProductionGuardError };

/**
 * Stores declare durability through a branded mechanism that is not
 * spoofable from a plain object literal. Production refuses to start
 * unless each named store carries the `DURABLE_BRAND` symbol — set
 * only by `markDurable()`, which an external durable adapter must
 * invoke after wiring its real durable backing store.
 *
 * Why a brand symbol rather than a plain string property: a caller
 * could trivially set `durability: "durable"` on a wrapper around an
 * in-memory store and bypass the guard. The brand is an unexported
 * `Symbol` keyed by package; the only way to attach it is via
 * `markDurable()`, which forces the implementor to consciously
 * attest "this backs to durable storage" rather than passively type
 * a string. Constructor identity is not a security boundary; an
 * intentional capability claim is.
 *
 * In-memory stores expose `durability: "ephemeral"` for inspection /
 * test wiring. Durable stores import `markDurable` and wrap their
 * concrete store before passing it to a channel factory.
 */
const DURABLE_BRAND: unique symbol = Symbol.for("@koi/channel-base/durable");

export type DurabilityDeclaration = "durable" | "ephemeral";

export type DurableStore<T> = T & { readonly [DURABLE_BRAND]: true };

/**
 * Brand a store as durable. The implementor MUST own a real durable
 * backing implementation (Postgres, Redis with persistence, S3, etc.)
 * before calling this — it is the explicit production-readiness
 * attestation. The returned object passes `assertDurableInProduction`.
 */
export function markDurable<T extends object>(store: T): DurableStore<T> {
  return Object.assign(Object.create(Object.getPrototypeOf(store)), store, {
    [DURABLE_BRAND]: true as const,
  }) as DurableStore<T>;
}

export function isDurable(store: unknown): boolean {
  if (typeof store !== "object" || store === null) return false;
  return (store as { readonly [DURABLE_BRAND]?: unknown })[DURABLE_BRAND] === true;
}

export function getDurability(store: unknown): DurabilityDeclaration | null {
  if (isDurable(store)) return "durable";
  if (typeof store !== "object" || store === null) return null;
  const v = (store as { readonly durability?: unknown }).durability;
  if (v === "ephemeral") return "ephemeral";
  return null;
}

/**
 * Returns ok:false in production when any of the named stores does
 * not declare `durability: "durable"`. Pass `{ name, store }` pairs
 * in the order they appear in the channel's dependency object so the
 * error message names the offender.
 */
export function assertDurableInProduction(
  production: boolean,
  stores: ReadonlyArray<{ readonly name: string; readonly store: unknown }>,
): ProductionGuardResult {
  if (!production) return { ok: true };
  const offenders = stores.filter((s) => getDurability(s.store) !== "durable").map((s) => s.name);
  if (offenders.length === 0) return { ok: true };
  return {
    ok: false,
    error: {
      code: "INVALID_CONFIG",
      message: `production mode requires markDurable()-branded stores; offenders (not branded durable): ${offenders.join(", ")}`,
    },
  };
}
