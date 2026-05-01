# @koi/middleware-policy-cache — Short-Circuit Verified Policy Bricks

`@koi/middleware-policy-cache` is an L2 middleware that bypasses the model whenever a tool call matches a brick that forge has *already verified and promoted* to policy mode. It runs at `intercept` phase with priority `150` (before permissions at `200`), evaluates a compiled policy executor synchronously, and either lets the call proceed (`allow`) or short-circuits with a typed error (`block`). On a cache hit there is no model round-trip and no further middleware below `intercept`.

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

1. Look up `cache.get(req.toolId)`. Miss → `next(req)` unchanged.
2. Hit → call `entry.execute(req.input)`. Decision is one of:
   - `{ action: "allow" }` → call `next(req)` so the real tool still runs. The cache validated the input shape, nothing more.
   - `{ action: "block", reason }` → return `{ output: { error: true, message: "Policy blocked: <reason>" } }` without calling `next`. No model call, no tool call.
3. Hits are deterministic by construction: `execute` is a pure function of `req.input`, so two identical inputs produce identical decisions.

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

The cache keeps a reverse index `brickId → toolId` so `evict(brickId)` is O(1). Re-registering a `brickId` against a different `toolId` cleans the stale forward entry, and re-registering a different `brickId` against the same `toolId` cleans the stale reverse entry. Both paths are tested.

---

## Why intercept@150

| Phase | Tier | Examples |
|---|---|---|
| `intercept` | 0 | `policy-cache` (150), `permissions` (200) |
| `resolve` | 1 | `call-dedup`, `tool-selector` |
| `observe` | 2 | `audit`, `event-trace` |

Policy-cache runs *before* permissions deliberately: a verified policy is the strongest possible authorization signal — it's a brick that forge has proven correct against the live tool surface. If the policy says `allow`, permissions still gets to run (we call `next`), so user gates are not bypassed. If the policy says `block`, we short-circuit before permissions even sees the call — the user shouldn't be prompted for a call that will deterministically fail.

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

// Wiring layer: register a verified, compiled policy
const result = handle.register({
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
