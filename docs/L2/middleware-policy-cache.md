# @koi/middleware-policy-cache — Short-Circuit Verified Policy Bricks

`@koi/middleware-policy-cache` is an L2 middleware that bypasses the model whenever a tool call matches a brick that forge has *already verified and promoted* to policy mode. It runs at `intercept` phase with priority `50` (outer of `permissions` at `100` — lower priority = outer onion = runs first), evaluates a compiled policy executor synchronously, and either lets the call proceed (`allow`) or short-circuits with a canonical block response (`block`). On a `block` hit there is no model round-trip, no permission prompt, and no tool execution.

Scoped at the brick level: `agent` (keyed by concrete `agentId`) and `global`. Capacity overflow uses true LRU — lookups touch entries so frequently-hit deny policies survive promotion churn. The handle exposes `dispose()` for explicit lifecycle teardown so long-lived `StoreChangeNotifier` instances don't leak listeners across runtime cycles.

This package is the v2 restoration of the v1 `middleware-policy-cache`. It is the one optimization that closes the loop between forge verification and runtime: a brick is forged → forge verification certifies it → the optimizer promotes it → this cache short-circuits the model on subsequent calls.

---

## ⚠️ Verified-only: every entry must carry proof

`register(entry)` rejects any `PolicyEntry` whose `verified` flag is not `true`. There is no opt-out. The cache exists *because* forge has independently certified the brick — accepting unverified entries would defeat the safety story and let an unstable harness output silently override the model.

**`register` returns a `Result<void, KoiError>`:**

- `{ ok: true, value: undefined }` — entry accepted, future tool calls for `entry.toolId` will short-circuit
- `{ ok: false, error: { code: "POLICY_NOT_VERIFIED", ... } }` — caller must ensure forge verification before retrying

The wiring layer (e.g. `forge-optimizer` reacting to a `StoreChangeEvent` of kind `"promoted"`) is responsible for compiling the brick into a `PolicyEntry` with `verified: true`. The cache trusts that flag the same way `@koi/middleware-permissions` trusts an approval-cache hit — both are downstream of an explicit verification step.

---

## Cache-hit semantics

On `wrapToolCall`:

1. Look up the request's `toolId` against the (scope, toolId) cache, in scope order `agent` → `zone` → `global` (matches `ANS_SCOPE_PRIORITY`). Miss → `next(req)` unchanged.
2. Hit → call `entry.execute(req.input)`. Decision is one of:
   - `{ action: "allow" }` → call `next(req)` so the real tool still runs. The cache validated the input shape, nothing more.
   - `{ action: "block", reason }` → return the **canonical block response** without calling `next`. No model call, no permission prompt, no tool execution.
3. Hits are deterministic by construction: `execute` is a pure function of `req.input`, so two identical inputs produce identical decisions.

If `execute` throws (schema drift, version skew, malformed input), the middleware **fails closed** for the current call AND **quarantines** the broken entry. The entry stays in the cache and every subsequent call returns the canonical block response — *without* re-invoking the broken executor and *without* falling through to a next-best scope. Quarantine is cleared by:

- Re-registering the same `brickId` (forge re-promotes a fixed brick), or
- An external `StoreChangeNotifier` event of kind `updated` / `removed` / `quarantined` for that `brickId`.

Quarantine — not eviction — is the right primitive here. Three failure modes in tension:

| Strategy | Verdict |
|---|---|
| Treat throw as cache miss → fall through to `next` | **Fail-open**: a stale deny silently reverts to "tool runs normally". Authorization regression. |
| Block + auto-evict | **Authorization downgrade**: subsequent calls fall through to next-best scope or unwrapped tool path. A transient executor fault on a deny reopens the tool. |
| Block + quarantine (this implementation) | **Safe**: deny stays enforced; recovery requires explicit re-promotion or external invalidation. |

Hosts wire `onExecutorError` (fire-and-forget callback in `PolicyCacheConfig`) to surface the broken promotion to audit / metrics / oncall. The callback is invoked inside its own `try/catch` so a misbehaving telemetry sink cannot change enforcement behavior — observability sits outside the trust boundary.

### Canonical block response

```typescript
{
  output: `Policy denied tool "${toolId}". This tool is not available in the current scope.`,
  metadata: {
    isError: true,
    blockedByHook: true,
    policyDenied: true,
    hookName: "policy-cache",
    toolId,
  },
}
```

The shape mirrors `middleware-permissions`'s deny payload so peer middleware (`event-trace`, `middleware-report`, `session-transcript`, `semantic-retry`) classifies the response as a non-execution rather than a successful tool call.

> **Trust boundary: `reason` is intentionally NOT in metadata.** `event-trace` allowlists `reason` and persists it to long-lived trajectory storage. An executor-supplied `reason` string can contain rule internals or input fragments that should not cross into observability. Permissions middleware applies the same policy: the deny is classified in metadata, but executor text never rides along. The model sees a generic block message; operators wanting per-rule attribution should attach to `onExecutorError` or correlate via `brickId` in their own logging path.

`wrapToolCall` is the only model/tool seam this middleware touches. It does not implement `wrapModelCall`, `wrapModelStream`, `onBeforeStop`, etc. — promotion is per-tool, not per-turn.

---

## Eviction

Three paths invalidate cached entries:

| Trigger | Mechanism |
|---|---|
| Manual revoke | `handle.evict(brickId)` — synchronous, idempotent |
| Capacity overflow | LRU on `register` when `cache.size >= maxEntries` (default `100`) — see "Capacity eviction is real LRU" |
| Store change event | Optional `StoreChangeNotifier` subscription evicts on `updated`, `removed`, `quarantined` |
| Handle teardown | `handle.dispose()` — see "Lifecycle: dispose()" |

The notifier subscription is registered eagerly during factory construction. The unsubscribe function is held in closure so disposal is implicit when the handle is dropped. Notifier callbacks are sync — events of kind `saved` and `promoted` are ignored (saving doesn't invalidate; promotion is what the wiring layer registers in response to).

The cache keeps a reverse index `brickId → cacheKey` so `evict(brickId)` is O(1). Re-registering a `brickId` against a different `(scope, toolId)` cleans the stale forward entry, and re-registering a different `brickId` against the same `(scope, toolId)` cleans the stale reverse entry. Both paths are tested.

## Scope-aware cache identity (owner-keyed)

`PolicyEntry` is a discriminated union by `scope`:

| Scope | Required identity | Cache key |
|---|---|---|
| `agent` | `agentId: string` | `agent:<agentId>:<toolId>` |
| `global` | — | `global:<toolId>` |

Encoding the **concrete owner** (not just the scope enum) is what gives the cache real tenant isolation: two different agents can both promote a policy for `search` and the cache holds both entries side-by-side. Without owner identity the first promotion would silently shadow every other agent's behavior for the same tool — the exact regression that defeats per-agent forge promotion.

At lookup time the middleware reads `ctx.session.agentId` and probes scopes in priority order: `agent` (most specific) → `global`, matching `ANS_SCOPE_PRIORITY`. An agent-scoped `block` overrides a more permissive global-scoped policy without removing it; evict the agent entry and the global takes over.

> **Why no `zone` scope?** `ForgeScope` defines three values (`agent`, `zone`, `global`), but `SessionContext` exposes no first-class zone field. Supporting `scope: "zone"` via opt-in metadata would let zone-scoped denies silently miss in any host that hadn't wired a resolver — exactly the kind of fail-open pattern this restoration was meant to remove. When the runtime threads zone identity through `SessionContext`, add `scope: "zone"` then.

## Capacity eviction is real LRU — and **per-owner**

`maxEntries` (default `100`) bounds memory. Two important properties:

1. **Real LRU, not FIFO.** `wrapToolCall` touches each lookup hit (delete + re-set) so the oldest entry in insertion order is always the least-recently-used. A frequently-hit deny policy registered early in the session survives churn from later promotions.
2. **Per-owner partitioning.** `maxEntries` applies *per agent* and once *globally*, not as a single shared budget. A noisy agent registering many policies can only evict its own entries — never another agent's deny. Without this, one tenant could register `maxEntries` allow-policies and silently knock another tenant's verified deny out of the cache, reopening the tool. Per-owner quotas turn capacity pressure from a cross-tenant attack vector into a self-limiting noise problem.

The brick-id reverse index is global (one brickId → one bucket), so eviction and external invalidation remain O(1).

## Lifecycle: `dispose()`

`PolicyCacheHandle.dispose()` releases the `StoreChangeNotifier` subscription (if any) and clears all cache state. It is **idempotent** — safe to call multiple times. Hosts that build a fresh runtime per request, per session, or per worker MUST call `dispose()` before dropping the handle, or every dropped instance will retain its closure on the shared notifier (the in-repo notifier enforces a 64-subscriber cap specifically to catch this leak).

---

## Why intercept@50

| Phase | Tier | Examples |
|---|---|---|
| `intercept` | 0 | `policy-cache` (50), `permissions` (100) |
| `resolve` | 1 | `call-dedup`, `tool-selector` |
| `observe` | 2 | `audit`, `event-trace` |

Lower priority = outer onion = runs first. Policy-cache wraps permissions deliberately: a verified policy is the strongest possible authorization signal — a brick forge has proven correct against the live tool surface. If the policy says `allow`, permissions still gets to run (we call `next`), so user gates are not bypassed. If the policy says `block`, we short-circuit before permissions even sees the call — the user shouldn't be prompted for a call that will deterministically fail.

---

## Capability fragment

`describeCapabilities` returns:

- `undefined` when the cache is empty (no model context cost)
- `{ label: "policy-cache", description: "<N> tools in policy mode (deterministic interception)" }` otherwise

The fragment exists so the model knows *that* a deterministic policy layer is active without leaking which tools are governed — that's an implementation detail and could change between turns.

---

## Public API

```typescript
import { createPolicyCacheMiddleware } from "@koi/middleware-policy-cache";

const handle = createPolicyCacheMiddleware({
  maxEntries: 100,                  // optional, default 100
  notifier: brickStoreNotifier,     // optional StoreChangeNotifier
});

// Wiring layer: register a verified, compiled, owner-keyed policy
const result = handle.register({
  scope: "agent",
  agentId: "agent-9f3a",       // required for agent scope
  toolId: "search",
  brickId: "brick-9f3a",
  verified: true,
  execute: (input) =>
    typeof input.query === "string" && input.query.length > 0
      ? { action: "allow" }
      : { action: "block", reason: "empty query" },
});
if (!result.ok) throw new Error(result.error.message);

// Compose into the runtime middleware stack
const middleware = handle.middleware;
```

`PolicyCacheHandle` exposes:

- `middleware: KoiMiddleware` — wire into `createKoi`
- `register(entry: PolicyEntry): Result<void, KoiError>` — verified-only
- `evict(brickId: string): void` — idempotent
- `size(): number` — observability
- `dispose(): void` — release notifier subscription + clear caches; idempotent

---

## Non-goals

- **Compiling policies.** That belongs to `forge-optimizer` / the harness. This middleware is a hot-path lookup, not a synthesizer.
- **TTL or time-based expiry.** Bricks have lifecycle events; we trust the notifier.
- **Cross-session persistence.** The cache lives for the lifetime of the handle. Promotion state is durable in the brick store; we re-hydrate via `register` at startup.
- **Caching `next(req)` outputs.** That's `@koi/middleware-call-dedup`'s job. Policy-cache short-circuits *before* the tool runs (on `block`) or simply lets it run (on `allow`).
