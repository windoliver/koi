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
import { KoiRuntimeError } from "@koi/errors";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PolicyDecision =
  | { readonly action: "allow" }
  | { readonly action: "block"; readonly reason: string };

interface PolicyEntryBase {
  readonly toolId: string;
  readonly brickId: string;
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
  /**
   * Trust boundary. Called inside `register()` with the FULL entry; the
   * cache accepts the registration only when this returns `true`. Hosts
   * wire forge into this callback at construction time — the cache never
   * trusts any field supplied by `register()`'s caller. Untrusted runtime
   * code with import access to `register()` cannot mint its own
   * verification because the verifier closure is captured at factory
   * construction by code that already has access to forge's verified-set.
   *
   * Why the full entry, not just `brickId`. A brickId-only verifier is
   * vulnerable to replay: a caller that observes any verified brickId
   * could register a forged policy under that ID with a different tool,
   * scope, agent, or executor and have it short-circuit before
   * permissions. Forge's verified-set is keyed on the full promotion
   * tuple (brickId, toolId, scope, agent, executor identity, generation),
   * so the verifier MUST inspect every field that contributes to
   * enforcement before returning `true`.
   *
   * If omitted, every registration is rejected (fail-closed). This is
   * intentional: the cache exists *because* forge has verified the brick,
   * so a host that wires the cache without wiring a verifier has misused
   * the API.
   *
   * Sync only — keeps `register()` synchronous. Hosts that need to consult
   * an async backend should resolve their state outside and pass a sync
   * lookup over an in-memory verified-set (forge maintains exactly such a
   * set).
   */
  readonly verifier?: (entry: PolicyEntry) => boolean;
  /**
   * Re-run the verifier on every cache hit before invoking the
   * executor. **Defaults to `true`.**
   *
   * Why default-on. Forge cannot generally prove content-immutability
   * for an arbitrary executor closure (TS `readonly` is compile-time
   * only, captured state can drift), so re-binding trust on every hit
   * is the only sound default. A mid-lifetime revocation (verifier
   * flips to false, or throws) evicts the entry and re-runs lookup
   * against the remaining cache hierarchy. If no other entry remains,
   * the call FAILS CLOSED with a canonical synthetic deny — observer
   * health is on the deny path here, intentionally, because the
   * alternative (delegate to next) would silently downgrade a verified
   * deny.
   *
   * Availability tradeoff. Verifier outages turn previously cached
   * traffic into hard denials. Hosts MUST keep the verifier O(1)
   * (in-memory hash-set lookup against forge's verified-set) and warm
   * the verified-set BEFORE accepting traffic. A fail-closed restart
   * gap is preferable to a fail-open authorization downgrade for an
   * authz cache.
   *
   * Opt-out (`false`). Hosts that can guarantee content-immutability
   * end-to-end (content-addressed bricks, no captured mutable state)
   * may opt out for the bare fast-path. The trust binding then lasts
   * for the entry's lifetime — only registration-time verification.
   */
  readonly verifyOnHit?: boolean | undefined;
  /**
   * Whether to evict on `updated`/`removed`/`quarantined` notifier
   * events that lack a `generation` when the cached entry has one.
   *
   * - `"suppress"` (default): fail closed — refuse to act on unversioned
   *   invalidations against versioned entries. Prevents a delayed event
   *   from an unknown version from dropping a freshly re-promoted deny.
   *   Hosts that mix versioned registrations with legacy unversioned
   *   notifiers must rotate the brickId or call `evict()` explicitly.
   * - `"evict"`: backward-compat mode — accept unversioned events as
   *   best-effort eviction. May lose a freshly re-promoted deny if the
   *   notifier delivers a stale event, but never strands invalidation
   *   from legacy hosts.
   *
   * Hosts SHOULD upgrade their notifier to emit `generation` end-to-end
   * (see `@koi/forge-tools`'s in-memory store for an example) and keep
   * the default `"suppress"`.
   */
  readonly unversionedInvalidationPolicy?: "suppress" | "evict" | undefined;
  /**
   * What to do when a `register()` would add a new (scope, owner,
   * toolId) slot to a bucket that is already at `maxEntries`.
   *
   * - `"fail-closed"` (default): refuse the new registration, leaving
   *   existing entries intact. Round 1 (v3 loop) ask. Prevents a noisy
   *   bucket from silently evicting a verified deny via LRU; the host
   *   sheds load or explicitly evicts before retrying.
   * - `"lru"`: evict the least-recently-used entry to make room.
   *   Round 9 (v3 loop) compromise: hosts that need newly verified
   *   denies to install even under memory pressure (and accept the
   *   theoretical risk of evicting an older deny in favor of the new
   *   one) opt in.
   */
  readonly fullBucketPolicy?: "fail-closed" | "lru" | undefined;
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
  /**
   * Optional resource enricher. middleware-permissions enriches resources
   * for tools whose effective resource depends on input — e.g. `bash:rm
   * /etc/passwd` instead of the bare `bash` toolId, or a fully resolved
   * absolute path for `fs.*` tools. The synthetic deny dispatched on
   * cache-hit blocks SHOULD use the same enriched resource so observers
   * (audit, monitor) aggregate denials under the same identity as the
   * normal permissions path. When omitted, the bare `request.toolId` is
   * used (backward-compatible default). When provided, the returned
   * `resource` is used in the deny query and the optional `path` is
   * merged into the query context (matching queryForTool's `path` field).
   *
   * Hosts SHOULD pass the same resolver they pass to
   * `@koi/middleware-permissions` to keep the two paths byte-identical.
   */
  readonly resolveResource?: (
    request: ToolRequest,
  ) => { readonly resource: string; readonly path?: string } | undefined;
  /**
   * Maximum number of synthetic block responses returned per turn for the
   * SAME (toolId, brickId) before the call hard-stops. Mirrors the
   * soft-deny retry cap in `@koi/middleware-permissions`: a model that
   * loops on the same cached deny would otherwise keep getting cheap
   * synthetic responses indefinitely, burning tokens and turn budget. On
   * the (cap+1)-th hit the middleware throws a hard error so the engine
   * loop terminates. Default: 5.
   */
  readonly perTurnBlockCap?: number | undefined;
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
  /**
   * Optional observer for permission-decision dispatch failures (sink
   * down, slow, or throwing). The deny fast-path always returns a
   * canonical block response — observer health does NOT change
   * enforcement. This hook lets the host surface degraded-audit
   * conditions (page oncall, increment a counter) without coupling tool
   * availability to audit sink availability. Fire-and-forget — a
   * throwing handler is contained.
   */
  readonly onDispatchError?: (info: {
    readonly brickId: string;
    readonly toolId: string;
    readonly scope: SupportedScope;
    readonly cause: unknown;
    readonly reason: "threw" | "rejected" | "timeout";
  }) => void;
  /**
   * Maximum milliseconds to await `dispatchPermissionDecision` before
   * giving up and proceeding with the canonical deny. Bounds the deny
   * fast-path against a slow or hanging audit sink. Default: 1000ms.
   * Set to 0 to disable awaiting entirely (fire-and-forget — observers
   * will receive the dispatch but the deny does not wait for them).
   */
  readonly dispatchTimeoutMs?: number | undefined;
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
const DEFAULT_PER_TURN_BLOCK_CAP = 5;
// Default 100ms — a small bounded await balancing the tradeoffs
// between rounds 4/7 v3:
//   - Round 4: an unbounded await couples deny enforcement to observer
//     health (slow sink → stalled deny path).
//   - Round 7: a 0ms fire-and-forget can lose the only audit record for
//     a cache-hit deny if the process tears down before the dispatch
//     promise resolves.
// 100ms gives audit a fair chance to durably record under normal
// conditions while keeping the deny fast-path bounded. Hosts that
// require strict durability set this higher; hosts on the bare
// fast-path set it to 0 (fire-and-forget).
const DEFAULT_DISPATCH_TIMEOUT_MS = 100;

// Distinguishes a dispatch-timeout from a real rejection so the
// observer-error hook can classify them. Plain object (not Error
// subclass) keeps the file class-free per project policy.
const DISPATCH_TIMEOUT_SENTINEL = Object.freeze({
  __policyCacheDispatchTimeout: true,
} as const);
type DispatchTimeoutSentinel = typeof DISPATCH_TIMEOUT_SENTINEL;
const isDispatchTimeout = (v: unknown): v is DispatchTimeoutSentinel =>
  typeof v === "object" && v !== null && "__policyCacheDispatchTimeout" in v;
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
  // Validate numeric caps at construction. A `maxEntries` of 0 (or
  // negative) would silently bypass capacity bounds — the per-bucket
  // overflow check evicts only when the bucket is non-empty, so a 0-cap
  // configuration would still admit the first registration. Operators
  // relying on capacity-zero as an incident-time kill switch need a
  // hard refusal, not a silent quota violation.
  if (
    config.maxEntries !== undefined &&
    (!Number.isInteger(config.maxEntries) || config.maxEntries < 1)
  ) {
    throw new Error(
      `policy-cache: maxEntries must be a positive integer, got ${String(config.maxEntries)}`,
    );
  }
  if (
    config.maxAgentBuckets !== undefined &&
    (!Number.isInteger(config.maxAgentBuckets) || config.maxAgentBuckets < 0)
  ) {
    // Without validation, NaN here makes `agentCaches.size >= maxAgentBuckets`
    // always false and the per-tenant memory bound stops working — a real
    // DoS risk under multi-tenant load.
    throw new Error(
      `policy-cache: maxAgentBuckets must be a non-negative integer, got ${String(config.maxAgentBuckets)}`,
    );
  }
  if (
    config.perTurnBlockCap !== undefined &&
    (!Number.isInteger(config.perTurnBlockCap) || config.perTurnBlockCap < 0)
  ) {
    // NaN, Infinity, or negative values would silently disable the
    // anti-loop guard (`count > NaN` is always false, etc.). Fail closed
    // at construction so an LLM cannot loop on synthetic denies forever.
    // 0 is allowed and means "any block trips the cap on first hit".
    throw new Error(
      `policy-cache: perTurnBlockCap must be a non-negative integer, got ${String(config.perTurnBlockCap)}`,
    );
  }
  if (
    config.dispatchTimeoutMs !== undefined &&
    (!Number.isFinite(config.dispatchTimeoutMs) || config.dispatchTimeoutMs < 0)
  ) {
    throw new Error(
      `policy-cache: dispatchTimeoutMs must be >= 0, got ${String(config.dispatchTimeoutMs)}`,
    );
  }
  const maxEntries = config.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxAgentBuckets = config.maxAgentBuckets ?? DEFAULT_MAX_AGENT_BUCKETS;
  const perTurnBlockCap = config.perTurnBlockCap ?? DEFAULT_PER_TURN_BLOCK_CAP;
  const dispatchTimeoutMs = config.dispatchTimeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS;
  // Per-turn block counter, keyed by `${turnId}\0${toolId}\0${brickId}`.
  // Mirrors middleware-permissions' soft-deny budgeting: a model that loops
  // on the same cached deny would otherwise burn tokens and turn budget on
  // unbounded synthetic responses. On the (cap+1)-th hit the middleware
  // throws so the engine loop terminates. Map insertion order is unrelated
  // to recency here — entries naturally fall out as turn IDs change.
  const perTurnBlocks = new Map<string, number>();
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
    // Trust boundary. The verifier closure is captured at factory
    // construction time by code that already has access to forge's
    // verified-set. `register()`'s caller cannot influence what the
    // verifier returns — there is no flag or token they can pass. Without
    // a verifier configured, fail closed: refuse every registration. The
    // cache exists *because* forge has verified the brick, so a host that
    // wires the cache without wiring a verifier has misused the API.
    if (config.verifier === undefined) {
      const error: KoiError = {
        code: "VALIDATION",
        message: `policy-cache: refusing unverified brick ${entry.brickId} for tool ${entry.toolId}`,
        retryable: false,
        context: { brickId: entry.brickId, toolId: entry.toolId },
      };
      return { ok: false, error };
    }
    // A throwing verifier is treated as a refusal, not a crash. The
    // verifier consults host-managed state (forge's verified-set), and a
    // transient bug or stale lookup must not propagate as an uncaught
    // exception out of the promotion subscriber. Fail closed: the
    // registration is refused and the cause is preserved for operators.
    let verified: boolean;
    try {
      verified = config.verifier(entry) === true;
    } catch (cause) {
      const error: KoiError = {
        code: "VALIDATION",
        message: `policy-cache: verifier threw for brick ${entry.brickId}; failing closed`,
        retryable: false,
        cause,
        context: { brickId: entry.brickId, toolId: entry.toolId },
      };
      return { ok: false, error };
    }
    if (!verified) {
      const error: KoiError = {
        code: "VALIDATION",
        message: `policy-cache: refusing unverified brick ${entry.brickId} for tool ${entry.toolId}`,
        retryable: false,
        context: { brickId: entry.brickId, toolId: entry.toolId },
      };
      return { ok: false, error };
    }

    // Slot-replacement gating against versioned-by-unversioned downgrade.
    // Refuse the strict downgrade (versioned cached entry replaced by
    // unversioned incoming) — a legacy unversioned event MUST NOT
    // displace a versioned authorization decision. The other corners
    // (both unversioned, or unversioned-by-versioned) are allowed:
    // legacy hosts that haven't propagated `generation` end-to-end
    // still need to install fresh denies. Hosts that want strict
    // refuse-on-either-unversioned should propagate `generation`.
    const destMapForCheck = entry.scope === "global" ? globalCache : agentCaches.get(entry.agentId);
    const destOccupantForCheck = destMapForCheck?.get(entry.toolId);
    if (
      destOccupantForCheck !== undefined &&
      destOccupantForCheck.brickId !== entry.brickId &&
      destOccupantForCheck.generation !== undefined &&
      entry.generation === undefined
    ) {
      const error: KoiError = {
        code: "VALIDATION",
        message: `policy-cache: refusing unversioned slot replacement for tool ${entry.toolId} (incoming brick ${entry.brickId}) — versioned cached entry cannot be displaced by an unversioned registration`,
        retryable: false,
        context: {
          brickId: entry.brickId,
          toolId: entry.toolId,
          currentGeneration: destOccupantForCheck.generation,
        },
      };
      return { ok: false, error };
    }

    // Generation-gated registration. When both the incoming and the
    // currently cached entry carry a `generation`, refuse a strictly older
    // generation — an event-driven promoter delivering a stale registration
    // out of order would otherwise silently roll authorization state
    // backward.
    if (entry.generation !== undefined) {
      // Validate generation is a finite non-negative integer. An
      // unchecked Infinity/NaN would pin this slot — every later
      // legitimate generation would compare older and be refused, and
      // notifier events with finite generations would be ignored. Treat
      // a malformed generation as a hard refusal.
      if (!Number.isInteger(entry.generation) || entry.generation < 0) {
        const error: KoiError = {
          code: "VALIDATION",
          message: `policy-cache: generation must be a non-negative integer, got ${String(entry.generation)} for brick ${entry.brickId}`,
          retryable: false,
          context: {
            brickId: entry.brickId,
            toolId: entry.toolId,
            generation: entry.generation,
          },
        };
        return { ok: false, error };
      }
      // Check (a) same-brickId replay AND (b) the destination
      // (bucket, toolId) slot. The slot check is required because
      // registration overwrites by (bucket, toolId), so an out-of-order
      // retry of an older brick id whose generation is strictly less
      // than the brick currently bound to that slot would otherwise
      // bypass the same-brickId gate and roll authorization backward.
      const candidates: PolicyEntry[] = [];
      const sameBrickRef = brickIndex.get(entry.brickId);
      if (sameBrickRef !== undefined) {
        const map =
          sameBrickRef.bucket === "global"
            ? globalCache
            : agentCaches.get(sameBrickRef.bucket.slice("agent:".length));
        const e = map?.get(sameBrickRef.toolId);
        if (e !== undefined) candidates.push(e);
      }
      const destMap = entry.scope === "global" ? globalCache : agentCaches.get(entry.agentId);
      const destOccupant = destMap?.get(entry.toolId);
      if (destOccupant !== undefined && destOccupant.brickId !== entry.brickId) {
        candidates.push(destOccupant);
      }
      for (const existing of candidates) {
        if (existing.generation !== undefined && entry.generation < existing.generation) {
          const error: KoiError = {
            code: "VALIDATION",
            message: `policy-cache: refusing stale generation ${String(entry.generation)} for brick ${entry.brickId} (current ${String(existing.generation)})`,
            retryable: false,
            context: {
              brickId: entry.brickId,
              toolId: entry.toolId,
              incomingGeneration: entry.generation,
              currentGeneration: existing.generation,
            },
          };
          return { ok: false, error };
        }
      }
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

    // Pre-mutation per-bucket capacity check. Round 1 (v3 loop) review:
    // LRU-evicting on overflow can silently drop a verified deny when a
    // noisy bucket churns through allow/deny promotions, after which
    // wrapToolCall's miss-path falls through to next() and the tool
    // becomes reachable through the weaker downstream permissions path.
    // Authorization downgrade. Fail closed instead — refuse the new
    // registration when the bucket is full so existing denies are
    // preserved. The error is retryable so forge can shed load or
    // explicitly evict before retrying.
    //
    // The bucket the entry will land in (after any cross-bucket move).
    const projectedBucketKey: string =
      entry.scope === "agent" ? `agent:${entry.agentId}` : "global";
    const projectedBucket = entry.scope === "global" ? globalCache : agentCaches.get(entry.agentId);
    // The new entry would land in this bucket only if no slot already
    // holds the same toolId (overwrite) AND the move is not bringing
    // the entry from the SAME (bucket, toolId) slot.
    const willAddNewSlot =
      projectedBucket !== undefined &&
      !projectedBucket.has(entry.toolId) &&
      !(
        prior !== undefined &&
        prior.bucket === projectedBucketKey &&
        prior.toolId === entry.toolId
      );
    if (projectedBucket !== undefined && willAddNewSlot && projectedBucket.size >= maxEntries) {
      if ((config.fullBucketPolicy ?? "fail-closed") === "lru") {
        // Opt-in LRU eviction (round 9 v3): make room by dropping the
        // least-recently-used entry so a newly verified deny can
        // install even under bucket pressure.
        const lruToolId = projectedBucket.keys().next().value;
        if (lruToolId !== undefined) {
          const oldEntry = projectedBucket.get(lruToolId);
          projectedBucket.delete(lruToolId);
          if (oldEntry !== undefined) {
            brickIndex.delete(oldEntry.brickId);
            quarantined.delete(oldEntry.brickId);
          }
        }
      } else {
        const error: KoiError = {
          code: "VALIDATION",
          message: `policy-cache: per-bucket capacity ${String(maxEntries)} reached for bucket ${projectedBucketKey}; refusing registration of ${entry.brickId} (would risk evicting a verified deny)`,
          retryable: true,
          context: {
            brickId: entry.brickId,
            toolId: entry.toolId,
            bucket: projectedBucketKey,
            maxEntries,
          },
        };
        return { ok: false, error };
      }
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

    // Per-bucket capacity is enforced at admission above (fail closed).
    // Reaching this point means there is room — overwrite-by-toolId is
    // explicitly allowed (it does not change the slot count).

    // Refresh LRU recency on overwrite. JavaScript `Map.set` on an
    // existing key does NOT move the entry to the end of insertion order,
    // so without an explicit delete+set a freshly re-promoted deny would
    // stay in its old LRU slot and could be evicted by the very next
    // insert into a full bucket. That converts a verified deny into a
    // cache miss — an authorization downgrade exactly on the
    // re-promotion / quarantine-recovery flows meant to restore broken
    // denies safely.
    // Snapshot the caller-supplied entry into a frozen internal record.
    // `readonly` is compile-time only, so without copying we'd retain a
    // reference to the caller's mutable object — any code still holding
    // it could swap out `execute`, flip the brickId, or rewrite metadata
    // AFTER the verifier has accepted the entry, silently turning a
    // verified deny into an allow on the next call. The shallow freeze
    // doesn't (and can't) protect the closure body itself, but it does
    // pin the policy-cache's view of the entry to what the verifier saw.
    // Preserve a versioned generation across same-brick refreshes that
    // omit `generation` (round 9 v3). Without this, a re-registration
    // of the same brickId without `generation` would strip the stored
    // generation, and subsequent unversioned notifier events would be
    // free to evict the freshly promoted deny — exactly the stale-
    // event protection the generation field was added for.
    const sameBrickRefresh = existing !== undefined && existing.brickId === entry.brickId;
    const inheritedGeneration =
      sameBrickRefresh && existing?.generation !== undefined && entry.generation === undefined
        ? existing.generation
        : undefined;
    const stored: PolicyEntry = Object.freeze({
      ...entry,
      ...(inheritedGeneration !== undefined ? { generation: inheritedGeneration } : {}),
    });
    bucketMap.delete(stored.toolId);
    bucketMap.set(stored.toolId, stored);
    brickIndex.set(stored.brickId, { bucket, toolId: stored.toolId });
    // Re-registration clears any prior quarantine on this brickId.
    quarantined.delete(stored.brickId);
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
        // Treat malformed event generations (NaN/Infinity/non-integer)
        // as unusable — fall through to best-effort eviction rather than
        // feeding garbage into the ordering check.
        const eventGen = event.generation;
        const eventGenValid = eventGen !== undefined && Number.isInteger(eventGen) && eventGen >= 0;
        if (
          current !== undefined &&
          eventGenValid &&
          current.generation !== undefined &&
          eventGen < current.generation
        ) {
          return;
        }
        // If the cached entry has a generation but the event lacks one,
        // behavior follows `unversionedInvalidationPolicy`:
        //  - "suppress" (default): skip — a delayed event from an
        //    unknown version could otherwise drop a freshly re-promoted
        //    deny (round 10 v2).
        //  - "evict": legacy backward compat — accept the event so
        //    hosts running unversioned notifiers don't strand stale
        //    invalidations behind manual cleanup (round 3 v3).
        if (
          current !== undefined &&
          current.generation !== undefined &&
          !eventGenValid &&
          (config.unversionedInvalidationPolicy ?? "suppress") === "suppress"
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
  // middleware-permissions denials.
  //
  // Durability vs. availability tradeoff. The synthetic-deny path bypasses
  // inner observe-phase middleware, so the durability barrier those
  // middleware normally provide must be re-established here — but
  // enforcement of the deny MUST NOT depend on observer health. We bound
  // the await with `dispatchTimeoutMs` and contain sync throws / async
  // rejections so a slow or poisoned audit sink can never (a) hang the
  // deny path, or (b) flip a permission-denied response into an
  // EXTERNAL/infrastructure failure. The deny is always returned as a
  // canonical block response by the caller; if the host needs to know
  // dispatch failed, it wires `onDispatchError` (paging, metrics).
  const dispatchSyntheticDeny = async (
    ctx: TurnContext,
    entry: PolicyEntry,
    request: ToolRequest,
  ): Promise<void> => {
    const dispatch = ctx.dispatchPermissionDecision;
    if (dispatch === undefined) return;
    let result: void | Promise<void>;
    try {
      // Identity AND context MUST match middleware-permissions' queryForTool
      // exactly so observers (audit, monitor) see one canonical permission
      // identity AND one canonical context per logical tool call. Mirrors
      // `buildPrincipal(agentId, userId, sessionId)` plus the merged
      // session/turn/request metadata that queryForTool builds. Values are
      // duplicated here (not imported) because L2 packages cannot import
      // from peer L2 packages.
      const userId = ctx.session.userId ?? "__anonymous__";
      const sessionId = ctx.session.sessionId as unknown as string;
      const principal = JSON.stringify([ctx.session.agentId, userId, sessionId]);

      // Replicate queryForTool's metadata-merge contract: session metadata
      // under `_session`, turn metadata flattened, request metadata under
      // `_request`. This keeps blocked-path observability byte-identical to
      // the normal permissions deny path.
      const sessionMeta = ctx.session.metadata;
      const turnMeta = ctx.metadata;
      const reqMeta = request.metadata;
      const hasSessionMeta = sessionMeta !== undefined && Object.keys(sessionMeta).length > 0;
      const hasTurnMeta = turnMeta !== undefined && Object.keys(turnMeta).length > 0;
      const hasReqMeta = reqMeta !== undefined && Object.keys(reqMeta).length > 0;
      // Resource enrichment: bash/fs.*/etc. denials carry their effective
      // target so observers can aggregate by command/path rather than by
      // bare toolId. When the host wires `resolveResource` (typically the
      // same resolver permissions middleware uses), the deny query reports
      // the enriched resource AND merges `path` into context — matching
      // queryForTool's contract.
      const resolved = config.resolveResource?.(request);
      const enrichedResource = resolved?.resource ?? request.toolId;
      const resolvedPath = resolved?.path;
      // Policy-cache provenance is intentionally NOT injected into the
      // dispatched query — that would split policy-cache denials from
      // normal permissions denials in any observer that keys on the
      // query body, breaking audit correlation. Provenance is delivered
      // out-of-band through `reportDecision` (brickId/scope/source/cap).
      const ctxField: JsonObject = {
        ...(hasSessionMeta ? { _session: sessionMeta } : {}),
        ...(hasTurnMeta ? turnMeta : {}),
        ...(hasReqMeta ? { _request: reqMeta } : {}),
        ...(resolvedPath !== undefined ? { path: resolvedPath } : {}),
      };
      // Mirror queryForTool: when the merged context has no fields,
      // omit `context` entirely from the PermissionQuery rather than
      // sending an empty object. Observers keying on the serialized
      // query body would otherwise split policy-cache denials into a
      // separate bucket from normal permissions denials on the very
      // common empty-metadata path.
      const hasAnyContext = Object.keys(ctxField).length > 0;
      // Reason is the fixed `SYNTHETIC_DENY_REASON` constant — NEVER the
      // executor-supplied reason. The deny path through `event-trace` and
      // friends persists `reason` to long-lived trajectory storage; sending
      // raw executor text would defeat the same trust boundary the
      // canonical block response already enforces in `metadata`.
      result = dispatch(
        {
          principal,
          action: "invoke",
          resource: enrichedResource,
          ...(hasAnyContext ? { context: ctxField } : {}),
        },
        { effect: "deny", reason: SYNTHETIC_DENY_REASON, disposition: "hard" },
      );
    } catch (cause) {
      reportDispatchError(entry, request, cause, "threw");
      return;
    }
    if (result === undefined) return;
    if (dispatchTimeoutMs === 0) {
      // Fire-and-forget mode: the deny does not wait for observers. We
      // still attach a catch handler so an async rejection cannot
      // surface as an unhandled rejection on the host process.
      void Promise.resolve(result).catch((cause: unknown) => {
        reportDispatchError(entry, request, cause, "rejected");
      });
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        result,
        new Promise<never>((_resolve, reject) => {
          // Bounded await — a hung observer must not stall the deny path.
          // We capture the handle so it can be cleared once the dispatch
          // promise wins, otherwise every blocked call would queue a
          // long-lived timer and burn wakeups under heavy denied traffic.
          timer = setTimeout(() => reject(DISPATCH_TIMEOUT_SENTINEL), dispatchTimeoutMs);
        }),
      ]);
    } catch (cause) {
      const reason: "rejected" | "timeout" = isDispatchTimeout(cause) ? "timeout" : "rejected";
      reportDispatchError(entry, request, cause, reason);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const reportDispatchError = (
    entry: PolicyEntry,
    request: ToolRequest,
    cause: unknown,
    reason: "threw" | "rejected" | "timeout",
  ): void => {
    try {
      config.onDispatchError?.({
        brickId: entry.brickId,
        toolId: request.toolId,
        scope: entry.scope,
        cause,
        reason,
      });
    } catch {
      // Throwing handler must not change enforcement.
    }
  };

  // Emit a structured decision into the trace stream so policy-cache spans
  // carry brickId/scope/source/cap-overflow alongside the synthetic
  // permission deny dispatched separately. The trace wrapper injects
  // `ctx.reportDecision` into the TurnContext only when a tracer is wired;
  // when absent this is a silent no-op.
  const reportDecision = (
    ctx: TurnContext,
    entry: PolicyEntry,
    request: ToolRequest,
    source: "executor" | "quarantine",
    capExceeded: boolean,
  ): void => {
    const report = ctx.reportDecision;
    if (report === undefined) return;
    try {
      report({
        middleware: NAME,
        action: "deny",
        toolId: request.toolId,
        brickId: entry.brickId,
        scope: entry.scope,
        source,
        capExceeded,
      });
    } catch {
      // Swallow trace failures; observability cannot break enforcement.
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

      // Hit-time re-verification. Defends against drift between the
      // verifier's view at registration and now — a brick revoked since
      // admission, or a closure whose external identity has changed in
      // a way the host's verifier can detect.
      //
      // Default-on. A verified executor's closure body can drift after
      // admission (TS `readonly` is compile-time only), so the only
      // sound default is to re-bind trust on every hit. Hosts that can
      // prove content-immutability (content-addressed bricks, no
      // captured mutable state) and need the bare fast-path can opt
      // out via `verifyOnHit: false`.
      //
      // Quarantine-on-failure (round 5 v3). Round 2 v3 fix evicted the
      // entry and ran the loop until a still-verified entry was found
      // or the cache emptied. That worked for the *current* call but
      // permanently removed the only enforcing entry — the very next
      // call missed cache and reached next(). A transient verifier
      // outage thus reopened a deny indefinitely. Fix: do NOT evict.
      // Tombstone via the existing `quarantined` set, which makes
      // every future call to this brickId fall through the quarantine
      // fast-path (always blocks). Quarantine is cleared by:
      //   - successful re-registration (host's verified-set re-binds)
      //   - explicit `evict()` from the host
      //   - notifier `removed`/`quarantined` events
      const verifyOnHit = config.verifyOnHit !== false;
      if (verifyOnHit && config.verifier !== undefined) {
        // Distinguish explicit revocation from transient verifier
        // outages (round 7 v3). A `false` return is an explicit
        // revocation by the host's verified-set: tombstone via
        // quarantine. A thrown exception is a transient error
        // (verified-set unavailable, lookup bug, restart gap) and
        // MUST NOT brick previously admitted tools — surface telemetry
        // via `onDispatchError` and trust the prior admission for this
        // call. Without this split, every verifier outage would
        // convert previously-allowed tools into persistent hard denies.
        let outcome: "verified" | "revoked" | "transient";
        try {
          outcome = config.verifier(entry) === true ? "verified" : "revoked";
        } catch (cause) {
          outcome = "transient";
          try {
            config.onDispatchError?.({
              brickId: entry.brickId,
              toolId: request.toolId,
              scope: entry.scope,
              cause,
              reason: "threw",
            });
          } catch {
            // Throwing handler must not change enforcement.
          }
        }
        if (outcome === "revoked") {
          // Tombstone then fall through to the shared quarantine
          // fast-path below — that path runs the per-turn cap counter
          // and reportDecision, both of which an early return would
          // skip.
          quarantined.add(entry.brickId);
        }
        // outcome === "transient": proceed using the prior admission.
      }

      // Per-turn block budget. Mirrors @koi/middleware-permissions'
      // soft-deny cap. Without this, a model looping on the same cached
      // deny would receive unbounded synthetic responses, burning tokens
      // and turn budget. Hits are counted BEFORE returning a synthetic
      // block; on overflow we throw so the engine loop terminates rather
      // than staying soft forever. The counter is keyed per-turn so
      // legitimate retries across separate turns are not penalized.
      // Cleanup is lifecycle-tied (onAfterTurn / onSessionEnd) so blocked
      // traffic cannot accumulate for the lifetime of the process.
      const turnId = ctx.turnId as unknown as string;
      const sessionId = ctx.session.sessionId as unknown as string;
      // Cap key is stable enforcement identity — NOT brickId. The same
      // tool slot is allowed to be re-promoted under a new brickId
      // (out-of-order retry, content-addressed redrive, generation
      // bumps), and a model looping on a denied tool would otherwise get
      // a fresh deny budget every time the brickId churns. Keying by
      // `(session, turn, scope-owner, tool)` collapses re-promotions onto
      // the same counter so the runaway-loop guard cannot be reset by
      // promotion churn the cache itself supports.
      const scopeOwner = entry.scope === "agent" ? `agent:${entry.agentId}` : "global";
      const blockKey = `${sessionId}\0${turnId}\0${scopeOwner}\0${request.toolId}`;
      const enforcePerTurnCap = async (source: "executor" | "quarantine"): Promise<void> => {
        const count = (perTurnBlocks.get(blockKey) ?? 0) + 1;
        perTurnBlocks.set(blockKey, count);
        if (count > perTurnBlockCap) {
          reportDecision(ctx, entry, request, source, true);
          // Also dispatch a final synthetic deny so observers see the
          // terminal block, then throw a structured PERMISSION error.
          // Plain Error would normalize to EXTERNAL downstream, which
          // misclassifies the runaway-loop hard-stop as an unexpected
          // tool failure instead of an authorization failure. Mirrors
          // @koi/middleware-permissions' soft→hard conversion path.
          // dispatchSyntheticDeny no longer throws on observer errors —
          // it routes failures to `onDispatchError` and returns. The
          // PERMISSION throw below is the authoritative fail-closed signal.
          await dispatchSyntheticDeny(ctx, entry, request);
          throw new KoiRuntimeError({
            code: "PERMISSION",
            message: `policy-cache: per-turn block cap ${String(perTurnBlockCap)} exceeded for tool "${request.toolId}" (brick ${entry.brickId}); aborting runaway loop`,
            retryable: false,
            context: {
              brickId: entry.brickId,
              toolId: request.toolId,
              scope: entry.scope,
              perTurnBlockCap,
              source,
            },
          });
        }
      };

      // Quarantined entries always block — keeps deny policies enforcing
      // even after their executor faults. Cleared by re-register or
      // external eviction (StoreChangeNotifier `removed` / `quarantined`).
      if (quarantined.has(entry.brickId)) {
        await enforcePerTurnCap("quarantine");
        reportDecision(ctx, entry, request, "quarantine", false);
        await dispatchSyntheticDeny(ctx, entry, request);
        return blockResponse(request.toolId);
      }

      // Clone before handing input to the executor so a buggy or
      // compromised executor cannot mutate live request fields that the
      // real tool will see when we forward via `next(request)`.
      let decision: PolicyDecision;
      try {
        decision = entry.execute(cloneInput(request.input));
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
        // Cap and dispatch happen OUTSIDE the executor try/catch so a cap
        // overflow throws cleanly to the engine loop (not re-caught here).
        await enforcePerTurnCap("quarantine");
        reportDecision(ctx, entry, request, "quarantine", false);
        await dispatchSyntheticDeny(ctx, entry, request);
        return blockResponse(request.toolId);
      }
      if (decision.action === "allow") return next(request);
      await enforcePerTurnCap("executor");
      reportDecision(ctx, entry, request, "executor", false);
      // `decision.reason` is intentionally NOT forwarded — see SYNTHETIC_DENY_REASON.
      await dispatchSyntheticDeny(ctx, entry, request);
      return blockResponse(request.toolId);
    },

    onAfterTurn: async (ctx) => {
      // Reap counters for the completed turn so blocked traffic cannot
      // accumulate for the lifetime of the handle. Per-turn counters are
      // keyed by `<sessionId>\0<turnId>\0...` so the prefix match cleanly
      // identifies entries to drop.
      const turnId = ctx.turnId as unknown as string;
      const sessionId = ctx.session.sessionId as unknown as string;
      const prefix = `${sessionId}\0${turnId}\0`;
      for (const key of perTurnBlocks.keys()) {
        if (key.startsWith(prefix)) perTurnBlocks.delete(key);
      }
    },

    onSessionEnd: async (sessionCtx) => {
      // Defense-in-depth: if a session ends mid-turn (cancellation,
      // timeout) the per-turn reaper above won't fire for the active
      // turn. Drop everything for this session.
      const sessionId = sessionCtx.sessionId as unknown as string;
      const prefix = `${sessionId}\0`;
      for (const key of perTurnBlocks.keys()) {
        if (key.startsWith(prefix)) perTurnBlocks.delete(key);
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
    perTurnBlocks.clear();
  };

  return {
    middleware,
    register,
    evict,
    size: sizeOf,
    dispose,
  };
}
