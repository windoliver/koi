/**
 * Hook policy — tier model, filtering, and grouping for managed environments.
 *
 * Tiers control hook precedence and disable-ability:
 * - `managed` — enterprise/admin hooks, cannot be disabled by users
 * - `user` — user settings / project config hooks
 * - `session` — in-memory / programmatic hooks
 *
 * All types and functions are internal to L2 — only `HookPolicy` flags live in L0.
 */

import type { HookConfig, HookPolicy, KoiError, Result } from "@koi/core";

// ---------------------------------------------------------------------------
// Tier type (L2-internal, not exported from L0)
// ---------------------------------------------------------------------------

/** Hook policy tier — determines precedence and disable-ability. */
export type HookTier = "managed" | "user" | "session";

/** Tier execution order (lower index = higher priority). */
const TIER_ORDER: readonly HookTier[] = ["managed", "user", "session"] as const;

// ---------------------------------------------------------------------------
// Registered hook — annotated HookConfig with stable identity
// ---------------------------------------------------------------------------

/**
 * A HookConfig annotated with its policy tier and a stable ID.
 *
 * The `id` is `${tier}:${hook.name}` — stable across array reordering
 * and policy filtering, unlike index-based tracking.
 */
export interface RegisteredHook {
  readonly id: string;
  readonly tier: HookTier;
  readonly hook: HookConfig;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Tags an array of validated HookConfigs with the given tier and generates
 * stable IDs. IDs are unique per instance — if two hooks share the same name
 * within a tier, a counter suffix is appended to distinguish them.
 */
export function createRegisteredHooks(
  hooks: readonly HookConfig[],
  tier: HookTier,
): readonly RegisteredHook[] {
  const nameCounts = new Map<string, number>();
  return hooks.map((hook) => {
    const count = (nameCounts.get(hook.name) ?? 0) + 1;
    nameCounts.set(hook.name, count);
    // First occurrence omits suffix for clean IDs; duplicates get #2, #3, etc.
    const id = count === 1 ? `${tier}:${hook.name}` : `${tier}:${hook.name}#${count}`;
    return { id, tier, hook };
  });
}

// ---------------------------------------------------------------------------
// Policy filtering
// ---------------------------------------------------------------------------

/** Actor that set the policy — determines `disableAllHooks` semantics. */
export type PolicyActor = "managed" | "user";

/**
 * Filters registered hooks based on the active policy and the actor who set it.
 *
 * - `disableAllHooks` + actor "managed" → kills ALL hooks (nuclear switch)
 * - `disableAllHooks` + actor "user" → kills user + session; managed survive
 * - `managedOnly` → only managed-tier hooks run
 * - Otherwise: filter on `allowUserHooks` (default true) and `allowSessionHooks` (default true)
 */
export function applyPolicy(
  hooks: readonly RegisteredHook[],
  policy: HookPolicy,
  actor: PolicyActor,
): readonly RegisteredHook[] {
  if (policy.disableAllHooks === true) {
    return actor === "managed" ? [] : hooks.filter((rh) => rh.tier === "managed");
  }

  if (policy.managedOnly === true) {
    return hooks.filter((rh) => rh.tier === "managed");
  }

  const allowUser = policy.allowUserHooks !== false;
  const allowSession = policy.allowSessionHooks !== false;

  if (allowUser && allowSession) {
    return hooks.slice();
  }

  return hooks.filter((rh) => {
    if (rh.tier === "managed") return true;
    if (rh.tier === "user") return allowUser;
    return allowSession;
  });
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

/** Hooks grouped by tier for phased dispatch. */
export interface TierGroups {
  readonly managed: readonly RegisteredHook[];
  readonly user: readonly RegisteredHook[];
  readonly session: readonly RegisteredHook[];
}

/**
 * Groups hooks by tier, preserving declaration order within each group.
 * Used by the registry for tier-phased dispatch.
 */
export function groupByTier(hooks: readonly RegisteredHook[]): TierGroups {
  const managed: RegisteredHook[] = [];
  const user: RegisteredHook[] = [];
  const session: RegisteredHook[] = [];

  for (const rh of hooks) {
    if (rh.tier === "managed") managed.push(rh);
    else if (rh.tier === "user") user.push(rh);
    else session.push(rh);
  }

  return { managed, user, session };
}

/**
 * Returns the tier execution order (managed → user → session).
 * Used by the registry to iterate tier phases.
 */
export function tierOrder(): readonly HookTier[] {
  return TIER_ORDER;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validates that no two registered hooks share the same name across *different* tiers.
 * Same-name hooks within the same tier are allowed (the loader already handles
 * intra-batch uniqueness, and the prior registry code supported this).
 * Returns an error only for cross-tier name collisions.
 */
export function validateNoDuplicateNames(hooks: readonly RegisteredHook[]): Result<void, KoiError> {
  const seen = new Map<string, HookTier>();

  for (const rh of hooks) {
    const existing = seen.get(rh.hook.name);
    if (existing !== undefined && existing !== rh.tier) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message:
            `Hook name "${rh.hook.name}" is registered in both "${existing}" and "${rh.tier}" tiers. ` +
            "Hook names must be unique across tiers.",
          retryable: false,
          context: { duplicateName: rh.hook.name, tiers: [existing, rh.tier] },
        },
      };
    }
    if (existing === undefined) {
      seen.set(rh.hook.name, rh.tier);
    }
  }

  return { ok: true, value: undefined };
}
