# @koi/hooks

> Hook loader, schema validation, and session-scoped hook lifecycle management.

## Layer

L2 — depends on `@koi/core` (L0) and `@koi/validation` (L0u).

## Purpose

Parses hook definitions from config, validates them against Zod schemas,
and manages session-scoped hook registration/cleanup. Hooks are side-effect
triggers (run a command, call a URL) that fire in response to session lifecycle
events.

> **Phase 1 scope:** This package provides the loader, schema, registry,
> executor, and middleware dispatch. `createHookMiddleware()` bridges hook
> execution into the `KoiMiddleware` contract for automatic dispatch during
> the engine lifecycle. `AgentManifest` does not yet include a `hooks`
> field — until then, callers wire hooks via `createHookMiddleware()`.

## Hook Event Kinds

All hook events use the `HookEventKind` string union — a closed set of
dot-separated lifecycle discriminators. The canonical list lives in
`@koi/core` as `HOOK_EVENT_KINDS` (array) and `HookEventKind` (type).

| Event | Fires when |
|-------|-----------|
| `session.started` | A new agent session begins |
| `session.ended` | A session terminates (success or abort) |
| `turn.started` | A new conversation turn begins |
| `turn.ended` | A conversation turn completes |
| `tool.before` | Immediately before a tool is invoked |
| `tool.succeeded` | A tool invocation completes successfully |
| `tool.failed` | A tool invocation fails |
| `permission.request` | A permission check is about to be evaluated |
| `permission.denied` | A permission check was denied |
| `compact.before` | Context compaction is about to run |
| `compact.after` | Context compaction has completed |
| `subagent.started` | A sub-agent has been spawned |
| `subagent.stopped` | A sub-agent has terminated |
| `config.changed` | Agent configuration was modified at runtime |

Adding new events is additive — extend the `HOOK_EVENT_KINDS` array in
`@koi/core`. Existing hooks are unaffected because filters use OR logic
within the `events` field.

**Forward compatibility:** The Zod schema accepts any non-empty string in
`filter.events`, not just known `HookEventKind` values. This ensures that
manifests referencing newly added events load successfully on nodes running
older `@koi/hooks` versions. Compile-time type safety is enforced by
`HookEventKind` in TypeScript — runtime validation guards structure, not
vocabulary.

## Hook Types

| Type | Trigger | Transport |
|------|---------|-----------|
| `command` | Shell command via `Bun.spawn` | Local process |
| `http` | HTTP POST/PUT to a URL | Network |
| `agent` | Sub-agent LLM loop via `SpawnFn` | In-process spawn |

### Agent Hook Type

Agent hooks spawn a verification sub-agent that can reason about context,
use tools, and return a structured verdict. They are the most powerful hook
type — use them for semantic checks that can't be expressed as static rules.

**Use cases:**
- Pre-commit security review (check diff for vulnerabilities)
- Output validation (verify model output meets policy)
- Semantic enforcement (check generated code follows conventions)
- Review gates (automated code review before tool execution)

**Design constraints:**
- Sub-agent runs **non-interactively** (`nonInteractive: true` on `SpawnRequest`) — it cannot prompt the user
- Must return structured output via the **HookVerdict** synthetic tool: `{ ok: boolean, reason?: string }`
- **Read-only by default** — `Bash`, `Write`, `Edit`, `NotebookEdit` denied alongside `spawn`/`agent`/`Agent`. Hook agents verify, not mutate. Opt in to write tools via `toolDenylist` override in hook config
- Registry-level suppression prevents hooks from firing inside hook agents (belt-and-suspenders recursion prevention)
- Token budget enforced per-session via `maxSessionTokens` (default: 500,000 — allows ~12 worst-case invocations)
- **Fail-closed by default** — if the agent times out, crashes, or doesn't produce a verdict, the operation is blocked

**Config example:**
```typescript
{
  kind: "agent",
  name: "security-reviewer",
  prompt: "Review this tool call for security issues. Block if the command could delete files or exfiltrate data.",
  model: "haiku",                    // cheap/fast model (default)
  systemPrompt: "You are a security auditor.", // optional override
  timeoutMs: 30000,                  // 30s (default: 60s)
  maxTurns: 5,                       // max assistant turns (default: 10)
  maxTokens: 2048,                   // per model call (default: 4096)
  maxSessionTokens: 25000,           // cumulative per session (default: 50000)
  toolDenylist: ["Write"],           // additional tools to deny
  filter: { events: ["tool.before"], tools: ["Bash", "Edit"] },
  failMode: "closed",               // "closed" (default) or "open"
}
```

**Decision mapping:** Agent hooks produce `continue` or `block` only — `modify` is not supported (LLMs cannot reliably produce JSON patches).

**Cost guidance:** Agent hooks consume LLM tokens on every matching event. Use `filter.tools` to restrict invocations to high-risk tools. The `maxSessionTokens` budget prevents runaway costs. Default to a cheap/fast model.

## Config Schema

Hook configs are passed directly to `loadHooks()` as a JSON/YAML array:

```typescript
import { loadHooks, createHookRegistry, executeHooks } from "@koi/hooks";

const result = loadHooks([
  {
    kind: "command",
    name: "on-session-start",
    cmd: ["./scripts/on-session-start.sh"],
    filter: { events: ["session.started"] },
    timeoutMs: 10000,
  },
  {
    kind: "http",
    name: "notify-backend",
    url: "https://api.example.com/hooks",
    method: "POST",
    headers: { Authorization: "Bearer ${HOOK_TOKEN}" },
    secret: "${WEBHOOK_SECRET}",
    filter: { events: ["session.started", "session.ended"] },
    timeoutMs: 5000,
  },
]);

if (!result.ok) throw new Error(result.error.message);

const registry = createHookRegistry();
registry.register(sessionId, agentId, result.value);
```

### Filter Syntax

Filters control which events trigger a hook. All filter fields use AND logic
(all specified conditions must match). Within a field, values use OR logic
(any value can match). Empty arrays are rejected at schema validation time.

| Field | Type | Description |
|-------|------|-------------|
| `events` | `string[]` | Session event kinds (e.g., `"session.started"`) |
| `tools` | `string[]` | Tool names to match |
| `channels` | `string[]` | Channel IDs to match |

When no filter is specified, the hook fires on all events.

## Execution Model

- **Parallel by default** — matching hooks run via `Promise.allSettled`
- **Serial opt-in** — set `serial: true` on a hook config for ordered execution
- **Declaration-order results** — results preserve manifest declaration order
- **Per-hook timeout** — `AbortSignal.timeout(hook.timeoutMs)` composed with
  session signal via `AbortSignal.any()`
- **Failure isolation** — one hook's failure never blocks others (parallel) or
  aborts the session
- **SIGKILL escalation** — stubborn command hooks get SIGTERM then SIGKILL after 2s

## Session Lifecycle

1. **Registration** — `loadHooks()` validates config, `HookRegistry.register()`
   binds hooks to a session with trusted `agentId`
2. **Execution** — `HookRegistry.execute(sessionId, event, abortSignal?)`
   dispatches matching hooks, enforcing session/agent identity on every call.
   The optional per-call `abortSignal` is combined with the session-level
   controller via `AbortSignal.any()` so either can cancel hook execution.
3. **Introspection** — `HookRegistry.has(sessionId)` reports registration;
   `HookRegistry.hasMatching(sessionId, event)` reports whether any registered
   hook's filter matches the event (for per-event fail-closed gating).
4. **Observer tap** — `CreateHookRegistryOptions.onExecuted` accepts an
   optional synchronous callback `(results, event) => void` that fires after
   every non-empty `execute()` (including exhausted once-hook synthetic blocks).
   Used by `@koi/runtime`'s ATIF trajectory recorder. Must not throw (wrapped
   in try/catch internally).
5. **Cleanup** — `HookRegistry.cleanup(sessionId)` aborts in-flight hooks and
   removes registration. Idempotent — double-cleanup is a no-op.

### Cancellation Semantics

Per-call `abortSignal` propagation is important for once-hook retry accounting:

- **Pre-claim short-circuit** — if the signal is aborted before claiming,
  the registry returns `[]` without touching once-hook state or retry counters.
- **Mid-flight rollback** — if the signal aborts during `executeHooks()`,
  claimed once-hooks are refunded *only* when their result carries the
  explicit `aborted: true` marker (see below). Genuine non-abort failures
  still increment `onceRetries` so fail-closed hooks reach
  `exhaustedBlockers` after `MAX_ONCE_RETRIES`.
- **Queued waiters** — when a once-hook is already running, queued calls
  wait behind it on `executeChain`. A queued caller whose signal aborts
  exits promptly with `[]` without blocking the chain advance.

### Abort Marker on `HookExecutionResult`

Executors set `aborted?: true` on results whose failure was caused by
caller cancellation (not hook deadline):

- **`executeCommandHook` / `executeHttpHook`** — sets `aborted: true` on
  `signal.aborted || e.name === "AbortError"`, but filters out cases where
  `signal.reason.name === "TimeoutError"` (hook's own deadline expiry).
- **`AgentHookExecutor.handleTransientFailure`** — accepts an `aborted`
  flag; the catch block sets it based on the same caller-vs-timeout
  distinction via `signal.reason` inspection.

The registry's refund predicate keys on `result.aborted === true` rather
than string-matching error messages.

## Security

- **HTTPS-only URLs** — HTTP loopback allowed only in dev mode (`NODE_ENV=development|test` or `KOI_DEV=1`)
- **No redirects** — `fetch()` uses `redirect: "error"` to prevent SSRF via 30x
- **Strict env-var expansion** — unresolved `${VAR}` in headers/secrets fails the hook
- **Trusted identity** — registry binds `agentId` at registration and overwrites caller-supplied identity on execute

## Middleware Dispatch

`createHookMiddleware()` returns a `KoiMiddleware` that dispatches hooks
during the engine lifecycle.

### Event Mapping

| Middleware hook | Event name | Decisions enforced? |
|-----------------|------------|---------------------|
| `onSessionStart` | `session.started` | Yes — `block` throws (session fails) |
| `onSessionEnd` | `session.ended` | No — awaited but decisions ignored |
| `onBeforeTurn` | `turn.started` | Yes — `block` throws (turn fails) |
| `onAfterTurn` | `turn.ended` | No (fire-and-forget) |
| `wrapToolCall` (pre) | `tool.before` | Yes — `block`/`modify` enforced |
| `wrapToolCall` (post-success) | `tool.succeeded` | Bounded-await for `transform` decisions |
| `wrapToolCall` (post-failure) | `tool.failed` | No (fire-and-forget) |
| `wrapModelCall` (pre) | `compact.before` | Yes — `block`/`modify` enforced |
| `wrapModelCall` (post) | `compact.after` | No (fire-and-forget) |
| `wrapModelStream` (pre) | `compact.before` | Yes — `block`/`modify` enforced |
| `wrapModelStream` (post) | `compact.after` | No (fire-and-forget) |

### Hook Decisions

Hooks return structured decisions via stdout (command) or response body (HTTP):

```json
{ "decision": "continue" }
{ "decision": "block", "reason": "bash not allowed in this context" }
{ "decision": "modify", "patch": { "cmd": "ls -la" } }
```

When no decision is returned (empty output, non-JSON), the hook defaults
to `continue`. Failed hooks (non-zero exit, HTTP 5xx) are treated per
their `failMode` — `"open"` (default for command/http) continues,
`"closed"` (default for agent) blocks.

Agent hooks return decisions via the `HookVerdict` synthetic tool (`{ ok: true }` →
`continue`, `{ ok: false, reason }` → `block`). They do not produce `modify`
decisions.

### Decision Aggregation

Pre-call hooks are aggregated with **most-restrictive-wins** precedence:
`block > modify > continue`. First `block` wins immediately. Multiple
`modify` patches are merged (later overrides earlier keys on conflict).
Failed hooks with `failClosed !== false` produce a `block` decision in
pre-call aggregation. Failed hooks with `failClosed: false` are skipped
(fail-open — observational/telemetry hooks). Post-call aggregation
(`aggregatePostDecisions`) follows the same `failClosed` semantics.

### Model Patch Safety

`modify` patches for model calls are filtered against an allowlist of
safe fields: `model`, `temperature`, `maxTokens`, `metadata`. Core
control fields (`messages`, `tools`, `systemPrompt`, `signal`) are
immutable — patches targeting them are silently dropped to prevent
hook bugs from corrupting request shape or disabling safeguards.

### Abort Guards

`wrapToolCall` fails closed on caller cancellation:
- **Pre-dispatch guard** — if `ctx.signal` is already aborted, throws `AbortError` without dispatching hooks or running the tool
- **Mid-dispatch guard** — if `ctx.signal` aborts during pre-hook dispatch (registry returns `[]`), throws `AbortError` before `next()`
- **Post-hook cancel-redaction** — if `ctx.signal` aborts during post-hook dispatch AND a fail-closed hook matches the event, output is redacted to prevent leaking unredacted data past a skipped security hook

### ATIF Trace Integration

When `wrapMiddlewareWithTrace` wraps the hook middleware (as it does in `@koi/runtime`),
hook execution decisions are captured in ATIF `middleware_span` metadata via
`ctx.reportDecision`. This surfaces per-hook timing and outcome in trajectory
documents without polling or introspection on the middleware itself.

**HookFireRecord** — the object pushed per `reportDecision` call:

```typescript
{
  event: "tool.before" | "compact.before"; // which lifecycle event fired
  toolId?: string;                          // present for tool events only
  hooks: Array<{
    name: string;                           // hook config name
    decision: "continue" | "block" | "modify" | "transform" | "error";
    durationMs: number;                     // wall-clock time for this hook
    error?: string;                         // only present when decision is "error"
  }>;
}
```

**When it fires:**
- `wrapToolCall` — after pre-call `tool.before` dispatch (blocking gate results only; post-call hooks are fire-and-forget and not traced)
- `wrapModelCall` — after pre-call `compact.before` dispatch
- `wrapModelStream` — after pre-call `compact.before` dispatch (via `dispatchModelPre`)

In ATIF, these appear inside the `decisions` array of a `middleware_span` step
for the `hooks` middleware:

```json
{
  "type": "middleware_span",
  "middlewareName": "hooks",
  "hook": "wrapToolCall",
  "decisions": [
    {
      "event": "tool.before",
      "toolId": "Bash",
      "hooks": [
        { "name": "security-reviewer", "decision": "continue", "durationMs": 142 }
      ]
    }
  ]
}
```

### Phase & Priority

The hook middleware runs at `resolve` phase, priority 400. Hooks are
business logic — not a permission engine.

```typescript
import { loadHooks, createHookMiddleware } from "@koi/hooks";

const result = loadHooks(manifestHooks);
if (!result.ok) throw new Error(result.error.message);

const middleware = createHookMiddleware({
  hooks: result.value,
  spawnFn,       // Required when any hook has kind: "agent" — provided by L1 engine
  onExecuted,    // Optional observer tap — e.g., from @koi/runtime's createHookObserver
});
// Wire into engine: createKoi({ middleware: [permissions, middleware, ...] })
```

> **Note:** `createHookMiddleware()` throws at creation time if any agent hooks
> are present but `spawnFn` is not provided. This is a fail-fast design — the
> error surfaces during setup, not during event dispatch.

### Fail Mode

All hook types support `failMode?: "open" | "closed"`:
- **`"open"`** (default for command/http) — failed hooks are treated as no opinion (continue)
- **`"closed"`** (default for agent) — failed hooks produce a `block` decision

Agent hooks default to closed because the whole point of spawning an LLM for
verification is that the check matters. Override with `failMode: "open"` for
advisory agent hooks.

## Module Structure

| File | Responsibility |
|------|---------------|
| `schema.ts` | Zod schemas for hook config validation |
| `loader.ts` | `loadHooks()` — validate raw config → typed `HookConfig[]` |
| `registry.ts` | `HookRegistry` — session-scoped registration/cleanup + hook-agent suppression |
| `executor.ts` | `executeHooks()` — parallel/serial dispatch with timeout + decision parsing |
| `agent-executor.ts` | `AgentHookExecutor` — sub-agent spawn, token accounting, verdict handling |
| `agent-verdict.ts` | `HookVerdict` tool schema, verdict parsing, decision mapping |
| `hook-executor.ts` | `HookExecutor` interface — extensible executor dispatch contract |
| `hook-validation.ts` | Shared validation — URL policy, timeout resolution, fail mode defaults |
| `filter.ts` | `matchesHookFilter()` — event/tool/channel matching |
| `env.ts` | `expandEnvVars()` — `${VAR}` substitution with strict validation |
| `middleware.ts` | `createHookMiddleware()` — KoiMiddleware bridging hooks to engine lifecycle |

## Dependencies

- `@koi/core` — `HookConfig`, `HookFilter`, `HookEvent`, `Result`, `KoiError`
- `@koi/validation` — `validateWith`, `zodToKoiError`
- `zod` — schema definitions
