# @koi/sandbox-router — Capability-Based Adapter Selection

Selects a `SandboxAdapter` from a registry based on a `SandboxProfile`'s
declared capability requirements, with create-time fallback and passive
lifecycle/health tracking. Returns a `SelectionDecision` audit record alongside
every successful instance.

## Why it exists

Koi v2 supports multiple sandbox backends (local subprocess, Docker, SSH,
future cloud adapters). Without a router, every caller has to hardcode which
adapter to use. The router lets a profile say "I need exec + persistence; pick
whatever satisfies that" and lets ops/configuration decide which adapters are
available at runtime.

## Layer

```
L2  @koi/sandbox-router
    depends on: @koi/core (L0)
    does NOT import: @koi/engine (L1), peer L2
```

## Public API

```typescript
import {
  createSandboxRouter,
  type SandboxRouter,
  type SelectionDecision,
} from "@koi/sandbox-router";

const router = createSandboxRouter({
  adapters: [localAdapter, dockerAdapter],
  degradedThreshold: 3, // optional, default 3
});

const result = await router.create(profile);
if (result.ok) {
  const { instance, decision } = result.value;
  // decision.selected.{name, version, state, capabilities}
  // decision.attempts:  ordered list of create() calls (failed + successful)
  // decision.rejected:  capability-filter rejections (never reached create)
} else {
  // result.error: KoiError with code = VALIDATION (no match) or UNAVAILABLE (all failed)
  // result.error.context.reason: "no-adapter-matches" | "all-adapters-failed"
}

router.describe(); // BackendDescriptor[] — used for ops/admin UIs
await router.shutdown();
```

## Selection algorithm

1. Filter adapters: drop any that lack a declared `capabilities`, are missing
   a required capability, hold a forbidden capability, or are already
   `terminated`.
2. Sort the survivors: `(state === "ready" ? 0 : 1)` ascending, then
   `priority` ascending.
3. Try `create()` on each in order. First success wins; build a decision and
   return.
4. After every failure, increment that adapter's consecutive-failure count.
   At `degradedThreshold` consecutive failures, the adapter flips to
   `degraded` (still selectable, but ranked behind ready peers).
5. Any successful `create()` resets the count and restores `ready`.
6. If every matched adapter fails, return `UNAVAILABLE` with `cause` chain
   and `context.causedBy` listing all per-adapter errors.

## Lifecycle

| Transition | Trigger |
|------------|---------|
| `created → ready` | `init?()` resolved (or omitted) |
| `created → terminated` | `init()` rejected |
| `ready → degraded` | `degradedThreshold` consecutive failures |
| `degraded → ready` | next successful `create()` |
| any non-terminated → `terminated` | `router.shutdown()` |

The router never polls — state changes only when an adapter is actually used
(or shut down).

## Audit shape

`SelectionDecision` is the unit of audit. The router does not persist; the
caller (typically `@koi/runtime`) is responsible for routing the decision into
its trajectory/event-trace pipeline.

```typescript
interface SelectionDecision {
  readonly selected: BackendDescriptor;
  readonly attempts: readonly SelectionAttempt[];   // try order; final entry == selected
  readonly rejected: readonly MatchRejection[];     // capability-filter rejections
}
```

## Error codes

| `KoiErrorCode` | Set when | `context.reason` |
|----------------|----------|------------------|
| `VALIDATION`   | No registered adapter satisfies the requirements | `"no-adapter-matches"` |
| `UNAVAILABLE`  | Every matched adapter's `create()` rejected      | `"all-adapters-failed"` |

`UNAVAILABLE` carries `context.causedBy: KoiError[]` — one entry per attempted
adapter, in attempt order.

## Limitations

- No live mid-session migration. Migration is create-time fallback only.
- No active health probing. Adapter health is inferred from `create()` outcomes.
- No cost-based selection — sort is `(state, priority)` only.
- Backends without a `capabilities` declaration cannot participate in router
  selection. They can still be invoked directly by callers that hold an
  adapter reference.
