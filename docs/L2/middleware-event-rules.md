# @koi/middleware-event-rules — Declarative Event-to-Action Rule Engine

`@koi/middleware-event-rules` is an L2 middleware package that maps engine events (tool failures, budget warnings, session lifecycle) to actions (escalate, notify, log, skip_tool) via declarative YAML rules. No custom middleware code needed.

---

## Why It Exists

Reacting to engine events currently requires writing custom middleware. For common patterns like "escalate after 3 tool failures" or "notify on high turn count", this is boilerplate. This package replaces that boilerplate with a YAML rule engine.

```
Without event-rules:
  Write middleware ─► implement onAfterTurn ─► track counter ─► check threshold
  ─► interpolate message ─► call escalation API ─► handle errors ─► test everything
  Total: ~200 lines of middleware code per pattern

With event-rules:
  rules:
    - name: tool-failure-escalate
      on: tool_call
      match: { ok: false, toolId: { regex: "^shell_" } }
      condition: { count: 3, window: "1m" }
      actions:
        - type: escalate
          message: "Tool {{toolId}} failed {{count}} times"
  Total: 8 lines of YAML
```

---

## Architecture

### Layer Position

```
L0  @koi/core                          ─ KoiMiddleware, ToolRequest, ToolResponse,
                                           SessionContext, TurnContext (types only)
L0u @koi/resolve                       ─ BrickDescriptor (manifest auto-resolution)
L0u @koi/validation                    ─ validateWith, zodToKoiError
L2  @koi/middleware-event-rules        ─ this package (no L1 dependency)
```

### Internal Module Map

```
index.ts                    ← public re-exports
│
├── types.ts                ← RuleEventType, MatchValue, CompiledRule, ActionContext, etc.
├── duration.ts             ← parseDuration("30s" → 30000)
├── interpolate.ts          ← interpolate("{{var}}", context)
├── rule-schema.ts          ← Zod validation + compilation (regex, duration, indexing)
├── rule-engine.ts          ← createRuleEngine() — evaluate rules, windowed counters
├── actions.ts              ← executeActions() — per-action dispatch with degradation
├── load-rules.ts           ← loadRulesFromFile/String (YAML → compiled ruleset)
├── rule-middleware.ts       ← createEventRulesMiddleware() factory
└── descriptor.ts           ← BrickDescriptor for manifest auto-resolution
```

### Middleware Priority

```
intercept tier (outermost)
  50  ─ event-rules        ← this package (outermost tool-call wrapper)
 100  ─ middleware-permissions
 175  ─ middleware-call-limits
resolve tier
 400  ─ hooks
observe tier
 500+ ─ telemetry / audit
```

The middleware runs at `intercept` phase, priority 50 — outermost wrapper for tool calls. It is positioned outside `permissions`, `call-limits`, and `hooks` so blocked/denied responses from those layers still flow back through this middleware and reach the rule engine's failure-classification path. An `observe`-phase placement would silently miss those upstream denials.

---

## How It Works

### Event Vocabulary

Rules use a local event vocabulary decoupled from `EngineEvent`:

| Event | Middleware Hook | Available Match Fields |
|-------|----------------|----------------------|
| `tool_call` | `wrapToolCall` (after `next()`) | `toolId`, `ok`, `blocked`, `blockedByHook`, `reason`, `agentId`, `sessionId`, `turnIndex`, flat `input` fields |
| `turn_complete` | `onAfterTurn` | `turnIndex`, `agentId`, `sessionId` |
| `session_start` | `onSessionStart` | `agentId`, `sessionId`, `userId`, `channelId` |
| `session_end` | `onSessionEnd` | `agentId`, `sessionId`, `userId`, `channelId` |

### Match Predicates

Flat object with value-driven dispatch:

| Syntax | Type | Example |
|--------|------|---------|
| `field: value` | Exact match | `ok: false` |
| `field: { regex: "pattern" }` | Regex | `toolId: { regex: "^shell_" }` |
| `field: { gte: n }` | Numeric comparison | `turnIndex: { gte: 15 }` |
| `field: [a, b, c]` | oneOf | `toolId: ["shell_exec", "file_write"]` |

All predicates in a rule's `match` block use AND logic.

**Distinguishing failures**: `tool_call` events expose `blocked`,
`blockedByHook`, and `reason` so circuit-breaker rules can exclude
policy denials from execution failures. To trip only on real failures
(not permission/hook denials):

```yaml
match: { ok: false, blocked: false, blockedByHook: false }
```

### Windowed Counters

Rules can require a minimum event count within a time window:

```yaml
condition:
  count: 3       # must match 3 times...
  window: "1m"   # ...within 1 minute
```

Counter state is session-scoped, in-memory, bounded to 1000 entries per partition, and pruned on read (no background timers). Binary search over sorted timestamps makes lookups efficient.

For `tool_call` rules, counters are **partitioned per tool**: a rule covering a family of tools (e.g. `match: { toolId: { regex: "^shell_" } }`) maintains a separate window per matched `toolId`, so failures on one tool cannot trip the threshold for a sibling tool. Other event types (`turn_complete`, `session_*`) use the rule name as the partition key.

### Built-in Actions

| Action | Required Fields | Dependency | Degradation |
|--------|----------------|------------|-------------|
| `emit` | `event` | `emitEvent` | Log fallback |
| `escalate` | `message` | `requestEscalation` | Log fallback |
| `log` | `level`, `message` | `logger` | Console fallback |
| `notify` | `channel`, `message` | `sendNotification` | Log fallback |
| `skip_tool` | `toolId` | None | Blocks in `wrapToolCall` |

Actions support `{{variable}}` template interpolation from event fields. Missing variables produce `"<undefined:varName>"` sentinels.

Each action is wrapped in try/catch — errors are logged but never propagate.

### Evaluation Order

Rules are evaluated in declaration order. By default all matching rules fire (evaluate-all). Set `stopOnMatch: true` on a rule to stop after the first match.

Rules are pre-indexed by event type at load time (`Map<EventType, Rule[]>`), so only relevant rules are evaluated per event.

---

## API Reference

### `createEventRulesMiddleware(config)`

Factory function that creates a `KoiMiddleware` with session lifecycle, turn, and tool call hooks.

```typescript
import { createEventRulesMiddleware, validateEventRulesConfig } from "@koi/middleware-event-rules";

const result = validateEventRulesConfig(yamlParsed);
if (!result.ok) throw new Error(result.error.message);

const mw = createEventRulesMiddleware({
  ruleset: result.value,
  actionContext: {
    requestEscalation: (msg) => escalationService.send(msg),
    sendNotification: (channel, msg) => notifier.send(channel, msg),
    logger: customLogger,
  },
});
```

Returns `KoiMiddleware` with:
- `name`: `"koi:event-rules"`
- `priority`: `50`
- `phase`: `"intercept"`
- `onSessionStart`, `onSessionEnd`, `onAfterTurn`, `wrapToolCall`
- `describeCapabilities`: returns `{ label: "event-rules", description: "..." }`

### `validateEventRulesConfig(input)`

Validates and compiles raw input (from YAML or object) into an immutable `CompiledRuleset`:

```typescript
const result = validateEventRulesConfig({
  rules: [{ name: "r1", on: "tool_call", actions: [{ type: "log", level: "warn", message: "x" }] }],
});
if (result.ok) {
  const ruleset = result.value; // CompiledRuleset
}
```

Performs exhaustive validation via Zod: unique rule names, valid event types, required action fields, regex compilation, duration parsing. Invalid input returns `Result<never, KoiError>`.

### `loadRulesFromFile(path)` / `loadRulesFromString(yaml)`

Convenience loaders that parse YAML and validate in one step:

```typescript
const result = await loadRulesFromFile("./rules.yaml");
if (result.ok) {
  const mw = createEventRulesMiddleware({ ruleset: result.value });
}
```

### `createRuleEngine(ruleset, now?)`

Low-level engine for evaluating rules outside of middleware context:

```typescript
const engine = createRuleEngine(ruleset, () => Date.now());
const result = engine.evaluate({ type: "tool_call", fields: { toolId: "shell_exec", ok: false }, sessionId });
// result.actions — matched actions to execute
// result.skipToolIds — tools to circuit-break
```

### `EventRulesConfig`

```typescript
interface EventRulesConfig {
  readonly ruleset: CompiledRuleset;   // Pre-validated + compiled rules
  readonly actionContext?: ActionContext; // Injected dependencies
  readonly now?: () => number;          // Clock injection for testing
}
```

### `ActionContext`

```typescript
interface ActionContext {
  readonly logger?: RuleLogger;
  readonly emitEvent?: (event: string, data: unknown) => void | Promise<void>;
  readonly requestEscalation?: (message: string) => void | Promise<void>;
  readonly sendNotification?: (channel: string, message: string) => void | Promise<void>;
}
```

---

## Examples

### Manifest-Driven (koi.yaml)

> **Manifest factory:** registered in the built-in registry as
> `@koi/middleware-event-rules`. The factory validates `options`
> through `validateEventRulesConfig` (Zod schema) at resolution time;
> misconfigured rulesets surface as `ManifestResolutionError`.
>
> **Manifest mode is log-only.** The factory **rejects** rulesets that
> use `skip_tool` (would let user-controlled YAML short-circuit inner
> permissions / call-limits / hooks) **or** `notify` / `emit` /
> `escalate` (those need host-wired handlers — manifest mode would
> silently degrade them to local logs, hiding alerting failures from
> operators). Manifest deployments support `log` actions only. For
> any other action type, use the **Programmatic Factory** path below
> with explicit `actionContext` wiring.

```yaml
middleware:
  - name: event-rules
    options:
      rules:
        - name: tool-failure-escalate
          on: tool_call
          match:
            ok: false
            toolId: { regex: "^shell_" }
          condition:
            count: 3
            window: "1m"
          actions:
            - type: escalate
              message: "Tool {{toolId}} failed {{count}} times in {{window}}"
          stopOnMatch: true

        - name: budget-warning
          on: turn_complete
          match:
            turnIndex: { gte: 15 }
          actions:
            - type: notify
              channel: status
              message: "Turn count {{turnIndex}} — session {{sessionId}}"

        - name: long-turn-alert
          on: turn_complete
          match:
            turnIndex: { gte: 20 }
          actions:
            - type: log
              level: warn
              message: "Session {{sessionId}} exceeded 20 turns"
```

### Programmatic Factory

```typescript
import {
  createEventRulesMiddleware,
  validateEventRulesConfig,
} from "@koi/middleware-event-rules";

const result = validateEventRulesConfig({
  rules: [
    {
      name: "block-dangerous-tools",
      on: "tool_call",
      match: { ok: false, toolId: { regex: "^(shell_|file_delete)" } },
      condition: { count: 2, window: "5m" },
      actions: [
        { type: "skip_tool", toolId: "shell_exec" },
        { type: "escalate", message: "Blocked {{toolId}} after repeated failures" },
      ],
    },
  ],
});

if (result.ok) {
  const mw = createEventRulesMiddleware({
    ruleset: result.value,
    actionContext: {
      requestEscalation: async (msg) => {
        await slackWebhook.send({ text: msg });
      },
    },
  });
}
```

---

## What This Feature Enables

### 1. Zero-Code Event Reactions

Define complex event-reaction patterns in YAML without writing middleware. Common patterns (escalation, alerting, circuit-breaking) become configuration rather than code.

### 2. Tool Circuit-Breaking

The `skip_tool` action blocks subsequent calls to a specific tool after failure thresholds are met. This prevents cascading failures — if `shell_exec` fails 3 times, it is automatically blocked for the rest of the session.

### 3. Budget and Turn Monitoring

Monitor session health with turn-count thresholds. Get notifications when sessions are running long (>15 turns) or send alerts when they exceed safety limits (>20 turns).

### 4. Windowed Failure Detection

Counters with time windows detect burst failures without triggering on spread-out errors. "3 failures in 1 minute" catches hot failures while ignoring occasional errors.

### 5. Graceful Degradation

All action dependencies are optional. If the escalation service is unavailable, escalate degrades to error logging. If the notification channel is missing, notify degrades to warning logging. Rules never crash the middleware pipeline.

### 6. Session-Scoped State

Each session gets its own rule engine with independent counter state. One session's failure count does not affect another's. State is cleaned up when the session ends.

### 7. Declarative Agent Governance

Combined with the manifest system, this enables platform operators to define governance policies (failure thresholds, alerting rules, safety limits) in the agent manifest without touching agent code.

---

## Performance

| Aspect | Design | Complexity |
|--------|--------|------------|
| Rule lookup | Pre-indexed `Map<EventType, Rule[]>` | O(1) type lookup |
| Predicate matching | Compiled closures (regex pre-compiled) | O(predicates) per rule |
| Counter access | Sorted array + binary search prune | O(log n) prune |
| Counter memory | Bounded 1000 entries per rule | Fixed upper bound |
| Compilation | One-time at load | O(rules) |
| Background work | None — prune-on-read only | Zero timers |

---

## Known Limitations

### Outermost-intercept short-circuit hides denials from inner observers

When a rule blocks a tool call, this middleware returns synthesized
denial response without calling `next()`. Because the middleware is the
**outermost** wrapper (intercept tier, priority 50), inner observe-tier
middleware (event-trace, audit, report) never sees the block. To
preserve baseline observability, every block emits a default `warn`-level
log to `actionContext.logger` (or `console.warn` when no logger is
configured) — audit/trace hosts that hook the logger pipeline will see
all denials without any extra wiring. For structured handling
(audit-event injection, paging, etc.), hosts may also wire
`actionContext.onBlock`, which fires alongside the default log and
receives `{ toolId, sessionId, reason }`.

### Half-open circuit-breaker semantics

A windowed `skip_tool` rule's block expires `windowMs` after the
**threshold-firing** real failure. Blocked retries do **not** extend the
expiry — that would let one transient failure burst become a self-
sustaining outage just from the agent retrying. After the window
elapses, the next call probes recovery; if it fails again, the rule
re-trips normally.



### Effective input post-rewrite

`tool_call` events are built from `request.input` as it entered this
middleware (the outermost intercept-phase wrapper). If an inner middleware
rewrites the input before execution (e.g. permissions sanitizing args),
match predicates and action templates will see the **pre-rewrite** input,
not the value the tool actually executed with. This is a property of v2's
wrapping middleware contract — there is no channel for inner middleware
to surface effective input back to outer wrappers — and applies equally
to peer audit/observe middleware. For policy decisions that depend on
post-sanitization input, run rules on the rewriting middleware's output
contract instead of relying on `tool_call` rules.

## Layer Compliance

```
@koi/middleware-event-rules imports:
  ✅ @koi/core        (L0)  — KoiMiddleware, SessionContext, TurnContext, etc.
  ✅ @koi/resolve      (L0u) — BrickDescriptor
  ✅ @koi/validation   (L0u) — validateWith
  ✅ zod               (ext) — schema validation
  ❌ @koi/engine       (L1)  — NOT imported
  ❌ peer L2            —      NOT imported
```

All interface properties are `readonly`. No vendor types. No framework-isms.
