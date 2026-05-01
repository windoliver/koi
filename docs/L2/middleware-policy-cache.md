# @koi/middleware-policy-cache — Short-Circuit Verified Policy Bricks

`@koi/middleware-policy-cache` is an L2 middleware that bypasses the model whenever a tool call matches a brick that forge has *already verified and promoted* to policy mode. It runs at `intercept` phase with priority `50` (outer of `permissions` at `100` — lower priority = outer onion = runs first), evaluates a compiled policy executor synchronously, and either lets the call proceed (`allow`) or short-circuits with a canonical block response (`block`). On a `block` hit there is no model round-trip, no permission prompt, and no tool execution.

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

If `execute` throws (schema drift, version skew, malformed input), the middleware **fails closed** for the current call (canonical block response, same shape as a normal `block` decision but with `reason` indicating executor failure) AND **auto-evicts** the broken entry. The next call for the same tool then falls through to the next-most-specific scope (e.g. `agent` failure → `zone` → `global`) or, if no other scope matches, runs the unwrapped tool path through permissions.

This combination prevents two failure modes in tension:

1. **Fail-open** — silently treating a throw as a cache miss would let a stale compiled deny policy revert to "tool runs normally" without any audit signal, exactly when verification is breaking.
2. **Bricked-forever** — failing closed without evicting would deny every subsequent call until manual intervention, even though forge can re-promote a fixed brick.

Hosts can wire `onExecutorError` (a fire-and-forget callback exposed in `PolicyCacheConfig`) to surface the broken promotion to audit / metrics / oncall channels. The cache otherwise tells nobody — observability is a host concern.

### Canonical block response

```typescript
{
  output: `Policy denied tool "${toolId}".`, // model-safe, leaks no internals
  metadata: {
    isError: true,
    blockedByHook: true,
    policyDenied: true,
    hookName: "policy-cache",
    toolId,
    reason, // structured, for telemetry only
  },
}
```

The shape mirrors `middleware-permissions`'s deny payload so peer middleware (`event-trace`, `middleware-report`, `session-transcript`, `semantic-retry`) classifies the response as a non-execution rather than a successful tool call.

`wrapToolCall` is the only model/tool seam this middleware touches. It does not implement `wrapModelCall`, `wrapModelStream`, `onBeforeStop`, etc. — promotion is per-tool, not per-turn.

---

## Eviction

Three paths invalidate cached entries:

| Trigger | Mechanism |
|---|---|
| Manual revoke | `handle.evict(brickId)` — synchronous, idempotent |
| Capacity overflow | LRU on `register` when `cache.size >= maxEntries` (default `100`) |
| Store change event | Optional `StoreChangeNotifier` subscription evicts on `updated`, `removed`, `quarantined` |

The notifier subscription is registered eagerly during factory construction. The unsubscribe function is held in closure so disposal is implicit when the handle is dropped. Notifier callbacks are sync — events of kind `saved` and `promoted` are ignored (saving doesn't invalidate; promotion is what the wiring layer registers in response to).

The cache keeps a reverse index `brickId → cacheKey` so `evict(brickId)` is O(1). Re-registering a `brickId` against a different `(scope, toolId)` cleans the stale forward entry, and re-registering a different `brickId` against the same `(scope, toolId)` cleans the stale reverse entry. Both paths are tested.

## Scope-aware cache identity (owner-keyed)

Forge bricks are scope-aware (`agent` | `zone` | `global` per `ForgeScope` in `@koi/core`). `PolicyEntry` is a discriminated union by `scope`:

| Scope | Required identity | Cache key |
|---|---|---|
| `agent` | `agentId: string` | `agent:<agentId>:<toolId>` |
| `zone` | `zoneId: string` | `zone:<zoneId>:<toolId>` |
| `global` | — | `global:<toolId>` |

Encoding the **concrete owner** (not just the scope enum) is what gives the cache real tenant isolation: two different agents can both promote a policy for `search` and the cache holds both entries side-by-side. Without owner identity the first promotion would silently shadow every other agent's behavior for the same tool — the exact regression that defeats per-agent forge promotion.

At lookup time the middleware reads `ctx.session.agentId` and (optionally) `ctx.session.metadata.zoneId` and probes scopes in priority order: `agent` (most specific) → `zone` → `global`, matching `ANS_SCOPE_PRIORITY`. An agent-scoped `block` therefore overrides a more permissive zone- or global-scoped policy without removing it; evict the agent entry and the next-most-specific scope takes over.

Hosts that don't model zones simply omit `zoneId` from session metadata — zone-scoped entries are then unreachable but agent and global entries continue to work.

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

---

## Non-goals

- **Compiling policies.** That belongs to `forge-optimizer` / the harness. This middleware is a hot-path lookup, not a synthesizer.
- **TTL or time-based expiry.** Bricks have lifecycle events; we trust the notifier.
- **Cross-session persistence.** The cache lives for the lifetime of the handle. Promotion state is durable in the brick store; we re-hydrate via `register` at startup.
- **Caching `next(req)` outputs.** That's `@koi/middleware-call-dedup`'s job. Policy-cache short-circuits *before* the tool runs (on `block`) or simply lets it run (on `allow`).
