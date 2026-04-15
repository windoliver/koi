# @koi/hooks

> Hook loader, schema validation, and session-scoped hook lifecycle management.

## Layer

L2 — depends on `@koi/core` (L0), `@koi/hook-prompt` (L0u), `@koi/redaction` (L0u), and `@koi/validation` (L0u).

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

| Type | Trigger | Transport | Cost |
|------|---------|-----------|------|
| `command` | Shell command via `Bun.spawn` | Local process | 0 tokens |
| `http` | HTTP POST/PUT to a URL | Network | 0 tokens |
| `prompt` | Single-shot LLM verification | Model API call | ~100-200 tokens |
| `agent` | Sub-agent LLM loop via `SpawnFn` | In-process spawn | ~4,000+ tokens |

### Prompt Hook Type

Prompt hooks make a single-shot LLM call for pass/fail verification. They fill
the gap between static hooks (command/http) and expensive agent hooks — use them
for simple semantic checks like "does this look safe?" without the overhead of a
multi-turn agent loop.

**Config example:**
```typescript
{
  kind: "prompt",
  name: "safety-check",
  prompt: "Is this tool call safe? Respond with ok:true if safe, ok:false with reason if not.",
  model: "anthropic/claude-sonnet-4-6",  // override model (default: cheap/fast)
  maxTokens: 256,                         // default: 256
  timeoutMs: 10000,                       // default: 10s
  filter: { events: ["tool.before"], tools: ["Bash"] },
  failClosed: true,                       // block on parse/API errors (default)
}
```

**Decision mapping:** Same as agent hooks — `{ ok: true }` → `continue`, `{ ok: false, reason }` → `block`. No `modify` support.

**Verdict parsing:** Uses `@koi/hook-prompt`'s hardened parser which handles fenced JSON extraction, string-boolean coercion (`"false"` → `false`), and plain-text denial language detection.

**Per-session token budget:** `DEFAULT_PROMPT_SESSION_TOKEN_BUDGET` (50,000 tokens) prevents cost amplification from rapid-fire prompt hook invocations.

**Wiring:** Requires a `PromptModelCaller` injected via `CreateHookMiddlewareOptions.promptCallFn`. The caller provides the model API call — the TUI wires this from its model adapter.

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
- **DNS-level SSRF guard** — pre-flight DNS resolution validates all resolved IPs against blocked CIDR ranges (RFC 1918, CGNAT, link-local/cloud metadata, TEST-NETs, broadcast). IPv6 transition mechanisms handled: IPv4-mapped (all forms), IPv4-compatible, 6to4 (2002::/16), NAT64 (64:ff9b::/96). Zone IDs stripped before validation. Narrow loopback allowed (127.0.0.1, ::1 only)
- **IP pinning** — HTTP hook URLs are rewritten to the resolved IP with the original hostname in the `Host` header, closing the DNS rebinding TOCTOU gap. HTTPS skips pinning (Bun TLS SNI unverified with IP URLs)
- **No redirects** — `fetch()` uses `redirect: "error"` to prevent SSRF via 30x
- **Header injection prevention** — expanded header values are validated for CRLF/NUL control characters (fail-closed). Reserved headers (`Host`, `Content-Length`, `Transfer-Encoding`, `Connection`) are rejected at both schema and runtime
- **Strict env-var expansion** — unresolved `${VAR}` in headers/secrets fails the hook. Double-whitelist model: per-hook `allowedEnvVars` intersected with system-wide `HookEnvPolicy`
- **Bounded response body** — HTTP hook responses are read via streaming with a 64KB byte-level cap. Truncated responses fail the hook (fail-closed) to prevent oversized responses from silently downgrading a `block` decision to `continue`
- **Trusted identity** — registry binds `agentId` at registration and overwrites caller-supplied identity on execute
- **Injectable DNS resolver** — `DnsResolverFn` parameter on `CreateHookMiddlewareOptions` allows custom resolvers for testing or environments with special DNS infrastructure. Defaults to `Bun.dns.lookup`

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

### Trajectory Visibility

Reports `{event, hooksFired, aggregated}` via `ctx.reportDecision()` on all hooks. When no user hooks are registered, reports `{hooksFired: 0, aggregated: "pass"}`. Shows `[0 hooks]` or `[allow]`/`[block]` in the TUI trajectory view.

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
  promptCallFn,  // Required when any hook has kind: "prompt" — PromptModelCaller
  onExecuted,    // Optional observer tap — e.g., from @koi/runtime's createHookObserver
});
// Wire into engine: createKoi({ middleware: [permissions, middleware, ...] })
```

> **Note:** `createHookMiddleware()` throws at creation time if agent hooks are
> present without `spawnFn`, or prompt hooks are present without `promptCallFn`.
> This is a fail-fast design — errors surface during setup, not during dispatch.

### Fail Mode

All hook types support `failMode?: "open" | "closed"`:
- **`"open"`** (default for command/http) — failed hooks are treated as no opinion (continue)
- **`"closed"`** (default for agent) — failed hooks produce a `block` decision

Agent hooks default to closed because the whole point of spawning an LLM for
verification is that the check matters. Override with `failMode: "open"` for
advisory agent hooks.

## Hook Policy Tiers

Hooks are classified into three tiers with different precedence and disable-ability:

| Tier | Source | Can be disabled by user? | Execution order |
|------|--------|--------------------------|-----------------|
| `managed` | Enterprise/admin config | No (unless admin sets `disableAllHooks`) | First |
| `user` | `~/.koi/hooks.json` or project config | Yes | Second |
| `session` | In-memory / programmatic (e.g., plugin hooks) | Yes | Third |

### Policy Filtering

The `HookPolicy` interface (L0) controls which tiers are active:

| Flag | Effect |
|------|--------|
| `disableAllHooks` + actor `"managed"` | Kills ALL hooks (nuclear switch) |
| `disableAllHooks` + actor `"user"` | Kills user + session; managed survive |
| `managedOnly` | Only managed-tier hooks run |
| `allowUserHooks` (default: true) | When false, user-tier hooks suppressed |
| `allowSessionHooks` (default: true) | When false, session-tier hooks suppressed |

### Registered Hooks

`RegisteredHook` annotates a `HookConfig` with a stable ID (`${tier}:${hook.name}`) and its tier. Stable IDs prevent loss of tracking when policies are reapplied or arrays are reordered. Cross-tier name collisions are rejected at validation time.

### API

```typescript
import {
  createRegisteredHooks,
  loadRegisteredHooks,
  loadRegisteredHooksPerEntry,
  applyPolicy,
  groupByTier,
} from "@koi/hooks";

// Tag raw configs with a tier
const userHooks = createRegisteredHooks(loadedConfigs, "user");
const pluginHooks = createRegisteredHooks(pluginConfigs, "session");

// Strict all-or-nothing load: any invalid entry rejects the whole array.
// Use this for schema validators / CI gates that want a hard failure.
const strict = loadRegisteredHooks(rawJson, "user");

// Per-entry load (#1781): one bad entry does NOT nuke its valid peers.
// Returns { hooks, errors, warnings } — each error carries a `kind`
// discriminator ("schema" | "duplicate" | "structural"), the declared
// `name` (when parseable), and `failClosed` (sniffed from the raw JSON
// when true) so hosts can apply fail-closed policy per entry.
const lenient = loadRegisteredHooksPerEntry(rawJson, "user");
for (const err of lenient.errors) console.warn(err.message);
const active = applyPolicy(lenient.hooks, policy, "user");

// Group for phased dispatch
const groups = groupByTier(active); // { managed, user, session }
```

### CLI / TUI Wiring

- `koi start`: User hooks from `~/.koi/hooks.json` are tagged `"user"`. Plugin hooks are tagged `"session"`.
- `koi tui`: Same tier tagging. Agent hooks (kind: `"agent"`) are filtered out (TUI has no `spawnFn`).

## Module Structure

| File | Responsibility |
|------|---------------|
| `schema.ts` | Zod schemas for hook config validation |
| `loader.ts` | `loadHooks()` — validate raw config → typed `HookConfig[]`; `loadRegisteredHooks()` — strict all-or-nothing load + tag with tier; `loadRegisteredHooksPerEntry()` — per-entry load with `HookLoadError[]` (kind: schema \| duplicate \| structural) so one bad entry doesn't nuke valid peers (#1781) |
| `policy.ts` | `RegisteredHook`, `HookTier`, `applyPolicy()`, `groupByTier()`, `validateNoDuplicateNames()` |
| `registry.ts` | `HookRegistry` — session-scoped registration/cleanup + hook-agent suppression + tier-phased dispatch |
| `executor.ts` | `executeHooks()` — parallel/serial dispatch with timeout + decision parsing |
| `agent-executor.ts` | `AgentHookExecutor` — sub-agent spawn, token accounting, verdict handling |
| `agent-verdict.ts` | `HookVerdict` tool schema, verdict parsing, decision mapping |
| `hook-executor.ts` | `HookExecutor` interface — extensible executor dispatch contract |
| `prompt-adapter.ts` | `PromptExecutorAdapter` — bridges `@koi/hook-prompt` into `HookExecutor` with abort handling, token budgeting, payload capping |
| `hook-validation.ts` | Shared validation — URL policy, timeout resolution, fail mode defaults |
| `ssrf.ts` | DNS-level SSRF guard — IP validation, DNS resolution, IP pinning |
| `header-sanitize.ts` | Header injection prevention — CRLF/NUL validation, reserved header blocking |
| `filter.ts` | `matchesHookFilter()` — event/tool/channel matching |
| `env.ts` | `expandEnvVars()` — `${VAR}` substitution with strict validation |
| `middleware.ts` | `createHookMiddleware()` — KoiMiddleware bridging hooks to engine lifecycle |

## Dependencies

- `@koi/core` — `HookConfig`, `HookFilter`, `HookEvent`, `Result`, `KoiError`
- `@koi/hook-prompt` — `PromptModelCaller`, `createPromptExecutor`, `VerdictParseError`
- `@koi/redaction` — secret redaction for payload forwarding
- `@koi/validation` — `validateWith`, `zodToKoiError`
- `zod` — schema definitions
