/**
 * Policy-cache middleware — short-circuits tool calls for forge-verified
 * bricks promoted to policy mode.
 *
 * Phase: intercept, priority 50 (outer of permissions@100 — lower = outer).
 * Eligibility: register() rejects entries with verified !== true.
 * Scope: agent-scoped (keyed by agentId) or global. Zone scope is intentionally
 *   omitted — `SessionContext` has no first-class zone field, and silently
 *   matching via opt-in metadata would let zone-scoped denies fail open in any
 *   host that hadn't wired a resolver. Add zone scope only after the runtime
 *   threads zone identity through `SessionContext`.
 * Failure handling: a throwing executor returns a canonical block response
 *   (fail-closed) AND quarantines the entry. Subsequent calls keep blocking
 *   until forge re-promotes a fixed brick or an external notifier event clears
 *   the entry. No fall-through to next-best scope — that would silently
 *   downgrade a deny.
 * Eviction: real LRU on capacity overflow (lookups touch entries).
 * Invalidation: optional StoreChangeNotifier subscription on
 *   "updated" | "removed" | "quarantined" events. The handle exposes
 *   `dispose()` so hosts can release the subscription before dropping the
 *   middleware.
 */

import type {
  CapabilityFragment,
  JsonObject,
  KoiError,
  KoiMiddleware,
  Result,
  StoreChangeEvent,
  StoreChangeNotifier,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PolicyDecision =
  | { readonly action: "allow" }
  | { readonly action: "block"; readonly reason: string };

interface PolicyEntryBase {
  readonly toolId: string;
  readonly brickId: string;
  /**
   * Non-forgeable verification token. Obtained by calling
   * `attestVerified({brickId, source})` AFTER the wiring layer has
   * confirmed forge has independently certified this brick. Replaces the
   * previous `verified: boolean` field — a boolean is caller-controlled
   * and cannot prevent a buggy or compromised wiring layer from silently
   * marking arbitrary executors as authoritative. The token is bound to
   * the same `brickId` as the entry; `register()` rejects entries whose
   * attestation has the wrong brickId or wasn't produced by
   * `attestVerified()`.
   */
  readonly attestation: VerifiedAttestation;
  /** Pure function of input → decision. Must not depend on external state. */
  readonly execute: (input: JsonObject) => PolicyDecision;
  /**
   * Monotonically increasing generation token for this brick. When set on
   * both `register()` and the corresponding `StoreChangeEvent.generation`,
   * the cache ignores notifier events whose generation is strictly older
   * than the currently stored entry — protects a freshly re-promoted deny
   * from being evicted by a delayed event for a prior generation. Hosts
   * that cannot supply a generation may omit the field; the cache then
   * falls back to best-effort eviction with no stale-event protection.
   */
  readonly generation?: number;
}

/**
 * Non-forgeable proof that a brick has been verified by forge. Construct
 * via `attestVerified()` — direct object literals do not satisfy the
 * runtime brand check inside `register()`, so a buggy or compromised
 * wiring layer cannot self-assert verification by hand-rolling
 * `{ brickId, source }` objects.
 */
export interface VerifiedAttestation {
  readonly brickId: string;
  readonly source: string;
}

// Module-private brand store. WeakSet membership is the runtime proof;
// since the brand is held in module scope, callers cannot obtain it
// without going through `attestVerified()`.
const VERIFIED_BRAND = new WeakSet<VerifiedAttestation>();

/**
 * Mint a verification token AFTER the wiring layer has confirmed forge has
 * independently certified the brick. The token is bound to `brickId` and is
 * checked at `register()` against the entry's brickId. This is the only
 * supported way to install a policy in the cache.
 *
 * Hosts wire this immediately after observing a `StoreChangeEvent` of kind
 * `"promoted"` whose forge metadata indicates verification:
 *
 * ```ts
 * notifier.subscribe((e) => {
 *   if (e.kind === "promoted" && e.policyChange?.to === "verified") {
 *     handle.register({
 *       ...,
 *       attestation: attestVerified({ brickId: e.brickId, source: "forge" }),
 *     });
 *   }
 * });
 * ```
 */
export function attestVerified(args: {
  readonly brickId: string;
  readonly source: string;
}): VerifiedAttestation {
  const token: VerifiedAttestation = Object.freeze({
    brickId: args.brickId,
    source: args.source,
  });
  VERIFIED_BRAND.add(token);
  return token;
}

/**
 * Owner-keyed policy entry. The current API supports `agent` and `global`
 * scopes. Zone scope was deliberately removed: until the runtime injects a
 * zone identifier into `SessionContext`, supporting `scope: "zone"` would
 * let zone-scoped denies silently miss in default hosts.
 */
export type PolicyEntry =
  | (PolicyEntryBase & {
      readonly scope: "agent";
      /** Concrete agent that owns this promotion — keys the cache slot. */
      readonly agentId: string;
    })
  | (PolicyEntryBase & { readonly scope: "global" });

/** Subset of `ForgeScope` actually supported by this middleware. */
export type SupportedScope = PolicyEntry["scope"];

export interface PolicyCacheConfig {
  /** Maximum cached policies per bucket (per-agent and global). Default: 100. */
  readonly maxEntries?: number | undefined;
  /**
   * Maximum number of distinct agent buckets retained. When exceeded, the
   * least-recently-used agent bucket is evicted in full. This bounds total
   * retained state across long-lived multi-tenant runtimes — without it, a
   * shared handle would retain `maxEntries` entries per distinct agentId
   * with no process-wide cap. Default: 1000.
   */
  readonly maxAgentBuckets?: number | undefined;
  /** Optional notifier for event-driven invalidation. */
  readonly notifier?: StoreChangeNotifier | undefined;
  /**
   * Optional callback invoked when a cached executor throws. The middleware
   * still returns a canonical block response and quarantines the entry; this
   * hook lets the host emit audit/metrics for the broken policy.
   * Fire-and-forget — the implementation isolates the call so a throwing
   * callback cannot change enforcement behavior.
   */
  readonly onExecutorError?: (info: {
    readonly brickId: string;
    readonly toolId: string;
    readonly scope: SupportedScope;
    readonly cause: unknown;
  }) => void;
}

export interface PolicyCacheHandle {
  readonly middleware: KoiMiddleware;
  /** Register a verified, compiled policy. Rejects unverified entries. */
  readonly register: (entry: PolicyEntry) => Result<void>;
  /** Evict a policy by brickId. Idempotent. */
  readonly evict: (brickId: string) => void;
  /** Number of cached policies. */
  readonly size: () => number;
  /**
   * Release the handle's resources. Unsubscribes from the configured
   * `StoreChangeNotifier` (if any) and clears all caches. Idempotent —
   * safe to call multiple times. Hosts MUST call this before dropping the
   * handle to avoid leaking subscriptions on long-lived notifiers.
   */
  readonly dispose: () => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_MAX_AGENT_BUCKETS = 1000;
const NAME = "policy-cache";
// Fixed deny reason used for both the synthetic permission decision and any
// caller that needs to format an audit string. Executor-supplied `reason`
// strings are NEVER forwarded across this boundary — they may carry rule
// internals or input fragments, and `event-trace` persists permission-decision
// reasons to long-lived trajectory storage.
const SYNTHETIC_DENY_REASON = "policy-cache: tool denied";
// permissions runs at priority 100; lower = outer onion = runs first.
const PRIORITY = 50;
const PHASE = "intercept" as const;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPolicyCacheMiddleware(config: PolicyCacheConfig = {}): PolicyCacheHandle {
  const maxEntries = config.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxAgentBuckets = config.maxAgentBuckets ?? DEFAULT_MAX_AGENT_BUCKETS;
  // Per-owner partitioned caches. Each agent gets its OWN map with its OWN
  // maxEntries quota; global gets its own. This is what gives the cache
  // tenant-safe capacity behavior: a noisy agent registering many policies
  // can only evict that agent's own entries — never another agent's deny.
  // Map insertion order is the recency record (lookups delete + re-set the
  // entry to bump it to most-recently-used; overflow evicts the LRU).
  const agentCaches = new Map<string, Map<string, PolicyEntry>>(); // agentId → toolId → entry
  const globalCache = new Map<string, PolicyEntry>(); // toolId → entry
  // brickId → { cacheKey: "agent:<agentId>" | "global", toolId } for O(1) evict.
  const brickIndex = new Map<string, { readonly bucket: string; readonly toolId: string }>();
  // Brick IDs whose compiled executor threw. Quarantined entries stay in the
  // cache and always return a canonical block response — they do NOT fall
  // through to next-best scope. Cleared on re-register or external eviction.
  const quarantined = new Set<string>(); // brickIds

  // Touch an agent bucket: bump its recency in `agentCaches` insertion order so
  // overflow eviction picks the LRU bucket.
  const touchAgentBucket = (agentId: string, m: Map<string, PolicyEntry>): void => {
    agentCaches.delete(agentId);
    agentCaches.set(agentId, m);
  };

  // Returns existing bucket or null when the cap is reached and the caller
  // must refuse the registration. Returning null is the fail-closed posture:
  // silently evicting another agent's bucket would convert that agent's
  // verified denies into cache misses, which would then fall through to the
  // normal tool path — a cross-tenant authorization downgrade dressed up as
  // capacity pressure. Refusing the new registration keeps every existing
  // deny enforced and surfaces the cap explicitly to the caller (forge),
  // which can shed load, evict explicitly, or shard.
  const getOrCreateAgentCache = (agentId: string): Map<string, PolicyEntry> | null => {
    const existing = agentCaches.get(agentId);
    if (existing !== undefined) {
      touchAgentBucket(agentId, existing);
      return existing;
    }
    if (agentCaches.size >= maxAgentBuckets) {
      return null;
    }
    const m = new Map<string, PolicyEntry>();
    agentCaches.set(agentId, m);
    return m;
  };

  const bucketFor = (entry: PolicyEntry): { key: string; map: Map<string, PolicyEntry> } | null => {
    if (entry.scope === "agent") {
      const map = getOrCreateAgentCache(entry.agentId);
      if (map === null) return null;
      return { key: `agent:${entry.agentId}`, map };
    }
    return { key: "global", map: globalCache };
  };

  const register = (entry: PolicyEntry): Result<void> => {
    // Non-forgeable attestation check. The attestation MUST have been
    // minted by `attestVerified()` (membership in module-private
    // VERIFIED_BRAND) AND its brickId MUST match the entry's brickId.
    // A hand-rolled `{ brickId, source }` literal — even with the right
    // shape — is rejected: it isn't in the brand set. This closes the
    // boolean-spoofing window where a buggy or compromised wiring layer
    // could install arbitrary executors by setting `verified: true`.
    if (
      entry.attestation === undefined ||
      !VERIFIED_BRAND.has(entry.attestation) ||
      entry.attestation.brickId !== entry.brickId
    ) {
      const error: KoiError = {
        code: "VALIDATION",
        message: `policy-cache: refusing unverified brick ${entry.brickId} for tool ${entry.toolId}`,
        retryable: false,
        context: { brickId: entry.brickId, toolId: entry.toolId },
      };
      return { ok: false, error };
    }

    // Transactional admission. Decide the outcome BEFORE mutating any
    // state — otherwise a failed cross-agent re-home at the bucket cap
    // would silently delete the existing entry for the moving brickId
    // (clearing brickIndex + the prior slot) and then bail with VALIDATION,
    // leaving the cache strictly worse than before.
    const targetBucketKey = entry.scope === "agent" ? `agent:${entry.agentId}` : "global";
    const prior = brickIndex.get(entry.brickId);
    const isMove =
      prior !== undefined && (prior.bucket !== targetBucketKey || prior.toolId !== entry.toolId);
    const priorAgentId =
      prior !== undefined && prior.bucket !== "global"
        ? prior.bucket.slice("agent:".length)
        : undefined;
    const priorMap =
      prior === undefined
        ? undefined
        : prior.bucket === "global"
          ? globalCache
          : priorAgentId !== undefined
            ? agentCaches.get(priorAgentId)
            : undefined;
    // The move would free a prior agent bucket only if it was the LAST
    // entry there AND that bucket isn't the destination.
    const moveWillFreeAgentBucket =
      isMove &&
      priorAgentId !== undefined &&
      priorMap !== undefined &&
      priorMap.size === 1 &&
      priorAgentId !== (entry.scope === "agent" ? entry.agentId : undefined);

    // A new agent bucket is needed only if the destination is agent-scoped
    // and that agent doesn't already have a bucket.
    const destNeedsNewAgentBucket = entry.scope === "agent" && !agentCaches.has(entry.agentId);

    if (
      destNeedsNewAgentBucket &&
      agentCaches.size >= maxAgentBuckets &&
      !moveWillFreeAgentBucket
    ) {
      // Cap reached and the move (if any) would NOT free a slot. Refuse
      // without mutating state. Marked retryable so forge can shed load
      // or evict explicitly first.
      const error: KoiError = {
        code: "VALIDATION",
        message: `policy-cache: agent-bucket cap reached (${String(maxAgentBuckets)}); refusing registration for ${entry.brickId}`,
        retryable: true,
        context: { brickId: entry.brickId, toolId: entry.toolId, maxAgentBuckets },
      };
      return { ok: false, error };
    }

    // Admission guaranteed — safe to mutate now.
    if (isMove && prior !== undefined) {
      if (prior.bucket === "global") {
        globalCache.delete(prior.toolId);
      } else if (priorAgentId !== undefined && priorMap !== undefined) {
        priorMap.delete(prior.toolId);
        if (
          priorMap.size === 0 &&
          priorAgentId !== (entry.scope === "agent" ? entry.agentId : "")
        ) {
          agentCaches.delete(priorAgentId);
        }
      }
      brickIndex.delete(entry.brickId);
    }

    const slot = bucketFor(entry);
    if (slot === null) {
      // Unreachable: pre-check guaranteed allocation succeeds. Throw rather
      // than silently corrupt state.
      throw new Error("policy-cache: bucket allocation failed after pre-check passed");
    }
    const { key: bucket, map: bucketMap } = slot;

    // Stale reverse entry: another brickId already occupies this (bucket, toolId).
    const existing = bucketMap.get(entry.toolId);
    if (existing !== undefined && existing.brickId !== entry.brickId) {
      brickIndex.delete(existing.brickId);
      quarantined.delete(existing.brickId);
    }

    // Capacity check is per-bucket — one tenant cannot evict another's deny.
    if (bucketMap.size >= maxEntries && !bucketMap.has(entry.toolId)) {
      const lruToolId = bucketMap.keys().next().value;
      if (lruToolId !== undefined) {
        const oldEntry = bucketMap.get(lruToolId);
        bucketMap.delete(lruToolId);
        if (oldEntry !== undefined) {
          brickIndex.delete(oldEntry.brickId);
          quarantined.delete(oldEntry.brickId);
        }
      }
    }

    bucketMap.set(entry.toolId, entry);
    brickIndex.set(entry.brickId, { bucket, toolId: entry.toolId });
    // Re-registration clears any prior quarantine on this brickId.
    quarantined.delete(entry.brickId);
    return { ok: true, value: undefined };
  };

  const evict = (brickId: string): void => {
    const ref = brickIndex.get(brickId);
    if (ref !== undefined) {
      const map =
        ref.bucket === "global" ? globalCache : agentCaches.get(ref.bucket.slice("agent:".length));
      map?.delete(ref.toolId);
      brickIndex.delete(brickId);
      // Garbage-collect empty agent caches so per-agent state doesn't leak.
      if (ref.bucket !== "global") {
        const agentId = ref.bucket.slice("agent:".length);
        if (agentCaches.get(agentId)?.size === 0) {
          agentCaches.delete(agentId);
        }
      }
    }
    quarantined.delete(brickId);
  };

  // Notifier subscription — track the unsubscribe so dispose() can release it.
  let unsubscribeNotifier: (() => void) | undefined;
  if (config.notifier !== undefined) {
    unsubscribeNotifier = config.notifier.subscribe((event: StoreChangeEvent) => {
      if (event.kind !== "updated" && event.kind !== "removed" && event.kind !== "quarantined") {
        return;
      }
      // Generation-aware invalidation. A stale event for a prior generation
      // of the same brickId is otherwise indistinguishable from a current
      // event and can silently evict a freshly re-promoted deny. When both
      // sides supply a generation, ignore events strictly older than what
      // the cache currently holds. Hosts that omit `generation` get the
      // legacy best-effort behavior — eviction proceeds.
      const ref = brickIndex.get(event.brickId);
      if (ref !== undefined) {
        const map =
          ref.bucket === "global"
            ? globalCache
            : agentCaches.get(ref.bucket.slice("agent:".length));
        const current = map?.get(ref.toolId);
        if (
          current !== undefined &&
          event.generation !== undefined &&
          current.generation !== undefined &&
          event.generation < current.generation
        ) {
          return;
        }
      }
      evict(event.brickId);
    });
  }

  // Lookup with LRU bump. Precedence: agent (most specific) → global.
  const findEntry = (ctx: TurnContext, toolId: string): PolicyEntry | undefined => {
    const agentMap = agentCaches.get(ctx.session.agentId);
    if (agentMap !== undefined) {
      const agentHit = agentMap.get(toolId);
      if (agentHit !== undefined) {
        agentMap.delete(toolId);
        agentMap.set(toolId, agentHit);
        // A hit for this agent makes its bucket most-recently-used at the
        // process level too — preserves it from cross-agent LRU eviction.
        touchAgentBucket(ctx.session.agentId, agentMap);
        return agentHit;
      }
    }

    const globalHit = globalCache.get(toolId);
    if (globalHit !== undefined) {
      globalCache.delete(toolId);
      globalCache.set(toolId, globalHit);
      return globalHit;
    }

    return undefined;
  };

  // Canonical block response. NOTE: `reason` is intentionally NOT placed in
  // metadata. event-trace allowlists `reason` and persists it to long-lived
  // trajectory storage, so an executor-supplied string could leak rule
  // internals or input fragments through that boundary. middleware-permissions
  // applies the same trust-boundary policy: classify in metadata, never
  // forward executor text.
  const blockResponse = (toolId: string): ToolResponse => ({
    output: `Policy denied tool "${toolId}". This tool is not available in the current scope.`,
    metadata: {
      isError: true,
      blockedByHook: true,
      policyDenied: true,
      hookName: NAME,
      toolId,
    },
  });

  // Emit a synthetic permission-deny so observe-phase middleware (audit,
  // monitor) sees policy-cache denials with the same shape as
  // middleware-permissions denials. Fire-and-forget — the host injects this
  // callback only when an observer is wired, and a throwing observer must
  // not change enforcement behavior.
  const dispatchSyntheticDeny = (ctx: TurnContext, entry: PolicyEntry, toolId: string): void => {
    const dispatch = ctx.dispatchPermissionDecision;
    if (dispatch === undefined) return;
    try {
      // Identity MUST match middleware-permissions exactly so observers
      // (audit, monitor) see one canonical permission identity per logical
      // tool call, rather than splitting policy-cache denies into a separate
      // namespace. Mirrors `buildPrincipal(agentId, userId, sessionId)` and
      // `queryForTool` from @koi/middleware-permissions: the values are
      // duplicated here (not imported) because L2 packages cannot import
      // from peer L2 packages.
      const userId = ctx.session.userId ?? "__anonymous__";
      const sessionId = ctx.session.sessionId as unknown as string;
      const principal = JSON.stringify([ctx.session.agentId, userId, sessionId]);
      const ctxField: JsonObject = {
        source: NAME,
        brickId: entry.brickId,
        scope: entry.scope,
      };
      // Reason is the fixed `SYNTHETIC_DENY_REASON` constant — NEVER the
      // executor-supplied reason. The deny path through `event-trace` and
      // friends persists `reason` to long-lived trajectory storage; sending
      // raw executor text would defeat the same trust boundary the
      // canonical block response already enforces in `metadata`.
      const result: void | Promise<void> = dispatch(
        {
          principal,
          action: "invoke",
          resource: toolId,
          context: ctxField,
        },
        { effect: "deny", reason: SYNTHETIC_DENY_REASON, disposition: "hard" },
      );
      // Async observers must also not destabilize enforcement. Wrap any
      // returned promise so a rejection cannot escape as an unhandled
      // rejection — mirrors the pattern in `middleware-permissions`.
      if (result !== undefined) {
        void Promise.resolve(result).catch(() => {
          // Swallow async observer failures; observability cannot break enforcement.
        });
      }
    } catch {
      // Swallow sync dispatch failures; observability cannot break enforcement.
    }
  };

  // structuredClone is the simplest defense against an executor mutating
  // request.input in place (TypeScript's `readonly` only enforces at compile
  // time). JsonObject is JSON-shaped, so structuredClone is safe and cheap.
  const cloneInput = (input: JsonObject): JsonObject => structuredClone(input);

  const sizeOf = (): number => {
    let n = globalCache.size;
    for (const m of agentCaches.values()) n += m.size;
    return n;
  };

  // Per-context size for capability reporting — only the current agent's
  // bucket plus the global bucket. Reporting the process-wide size would
  // leak other tenants' policy counts into this turn's prompt context and
  // make injection non-deterministic across agents sharing one handle.
  const sizeFor = (ctx: TurnContext): number => {
    const agent = agentCaches.get(ctx.session.agentId);
    return globalCache.size + (agent?.size ?? 0);
  };

  const middleware: KoiMiddleware = {
    name: NAME,
    priority: PRIORITY,
    phase: PHASE,

    async wrapToolCall(ctx, request: ToolRequest, next): Promise<ToolResponse> {
      const entry = findEntry(ctx, request.toolId);
      if (entry === undefined) return next(request);

      // Quarantined entries always block — keeps deny policies enforcing
      // even after their executor faults. Cleared by re-register or
      // external eviction (StoreChangeNotifier `removed` / `quarantined`).
      if (quarantined.has(entry.brickId)) {
        dispatchSyntheticDeny(ctx, entry, request.toolId);
        return blockResponse(request.toolId);
      }

      try {
        // Clone before handing input to the executor so a buggy or
        // compromised executor cannot mutate live request fields that the
        // real tool will see when we forward via `next(request)`.
        const decision = entry.execute(cloneInput(request.input));
        if (decision.action === "allow") return next(request);
        // `decision.reason` is intentionally NOT forwarded — see SYNTHETIC_DENY_REASON.
        dispatchSyntheticDeny(ctx, entry, request.toolId);
        return blockResponse(request.toolId);
      } catch (cause) {
        quarantined.add(entry.brickId);
        try {
          config.onExecutorError?.({
            brickId: entry.brickId,
            toolId: entry.toolId,
            scope: entry.scope,
            cause,
          });
        } catch {
          // Swallow callback failures; observability cannot break enforcement.
        }
        dispatchSyntheticDeny(ctx, entry, request.toolId);
        return blockResponse(request.toolId);
      }
    },

    describeCapabilities(ctx: TurnContext): CapabilityFragment | undefined {
      const n = sizeFor(ctx);
      if (n === 0) return undefined;
      return {
        label: NAME,
        description: `${String(n)} tool${n === 1 ? "" : "s"} in policy mode (deterministic interception)`,
      };
    },
  };

  const dispose = (): void => {
    if (unsubscribeNotifier !== undefined) {
      try {
        unsubscribeNotifier();
      } catch {
        // Swallow notifier teardown errors — disposal must be idempotent.
      }
      unsubscribeNotifier = undefined;
    }
    agentCaches.clear();
    globalCache.clear();
    brickIndex.clear();
    quarantined.clear();
  };

  return {
    middleware,
    register,
    evict,
    size: sizeOf,
    dispose,
  };
}
