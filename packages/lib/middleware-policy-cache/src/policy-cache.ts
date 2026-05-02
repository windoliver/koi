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
  const perTurnBlockCap = config.perTurnBlockCap ?? DEFAULT_PER_TURN_BLOCK_CAP;
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
    if (config.verifier === undefined || config.verifier(entry) !== true) {
      const error: KoiError = {
        code: "VALIDATION",
        message: `policy-cache: refusing unverified brick ${entry.brickId} for tool ${entry.toolId}`,
        retryable: false,
        context: { brickId: entry.brickId, toolId: entry.toolId },
      };
      return { ok: false, error };
    }

    // Generation-gated registration. When both the incoming and the
    // currently cached entry carry a `generation`, refuse a strictly older
    // generation — an event-driven promoter delivering a stale registration
    // out of order would otherwise silently roll authorization state
    // backward. Hosts that omit `generation` opt out of this protection.
    if (entry.generation !== undefined) {
      const existingRef = brickIndex.get(entry.brickId);
      if (existingRef !== undefined) {
        const existingMap =
          existingRef.bucket === "global"
            ? globalCache
            : agentCaches.get(existingRef.bucket.slice("agent:".length));
        const existing = existingMap?.get(existingRef.toolId);
        if (
          existing !== undefined &&
          existing.generation !== undefined &&
          entry.generation < existing.generation
        ) {
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

    // Refresh LRU recency on overwrite. JavaScript `Map.set` on an
    // existing key does NOT move the entry to the end of insertion order,
    // so without an explicit delete+set a freshly re-promoted deny would
    // stay in its old LRU slot and could be evicted by the very next
    // insert into a full bucket. That converts a verified deny into a
    // cache miss — an authorization downgrade exactly on the
    // re-promotion / quarantine-recovery flows meant to restore broken
    // denies safely.
    bucketMap.delete(entry.toolId);
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
  const dispatchSyntheticDeny = (
    ctx: TurnContext,
    entry: PolicyEntry,
    request: ToolRequest,
  ): void => {
    const dispatch = ctx.dispatchPermissionDecision;
    if (dispatch === undefined) return;
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
      const merged: JsonObject = {
        ...(hasSessionMeta ? { _session: sessionMeta } : {}),
        ...(hasTurnMeta ? turnMeta : {}),
        ...(hasReqMeta ? { _request: reqMeta } : {}),
        ...(resolvedPath !== undefined ? { path: resolvedPath } : {}),
        // Policy-cache provenance always present so observers can route on it.
        _policyCache: { brickId: entry.brickId, scope: entry.scope },
      };
      const ctxField: JsonObject = merged;
      // Reason is the fixed `SYNTHETIC_DENY_REASON` constant — NEVER the
      // executor-supplied reason. The deny path through `event-trace` and
      // friends persists `reason` to long-lived trajectory storage; sending
      // raw executor text would defeat the same trust boundary the
      // canonical block response already enforces in `metadata`.
      const result: void | Promise<void> = dispatch(
        {
          principal,
          action: "invoke",
          resource: enrichedResource,
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
      const blockKey = `${sessionId}\0${turnId}\0${request.toolId}\0${entry.brickId}`;
      const enforcePerTurnCap = (source: "executor" | "quarantine"): void => {
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
          dispatchSyntheticDeny(ctx, entry, request);
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
        enforcePerTurnCap("quarantine");
        reportDecision(ctx, entry, request, "quarantine", false);
        dispatchSyntheticDeny(ctx, entry, request);
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
        enforcePerTurnCap("quarantine");
        reportDecision(ctx, entry, request, "quarantine", false);
        dispatchSyntheticDeny(ctx, entry, request);
        return blockResponse(request.toolId);
      }
      if (decision.action === "allow") return next(request);
      enforcePerTurnCap("executor");
      reportDecision(ctx, entry, request, "executor", false);
      // `decision.reason` is intentionally NOT forwarded — see SYNTHETIC_DENY_REASON.
      dispatchSyntheticDeny(ctx, entry, request);
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
