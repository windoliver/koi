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
 * Stores must self-declare durability. Production refuses to start
 * unless each named store advertises `durability === "durable"`.
 *
 * Why an explicit property rather than `instanceof`-based detection:
 * a wrapper that forwards every method call to an `InMemory*Store`
 * would pass an `instanceof` check trivially while silently being
 * restart-fragile. Constructor identity is not a security boundary;
 * an explicit capability claim is.
 *
 * Implementors of durable stores MUST assign `durability: "durable"`
 * (see `InMemoryIdempotencyStore` etc. for the `"ephemeral"`
 * counterexample). Stores that omit the property are treated as
 * undeclared and rejected in production for the same reason a missing
 * claim is rejected: production cannot infer durability from absence.
 */
export type DurabilityDeclaration = "durable" | "ephemeral";

export function getDurability(store: unknown): DurabilityDeclaration | null {
  if (typeof store !== "object" || store === null) return null;
  const v = (store as { readonly durability?: unknown }).durability;
  if (v === "durable" || v === "ephemeral") return v;
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
      message: `production mode requires stores declaring durability: "durable"; offenders: ${offenders.join(", ")}`,
    },
  };
}
