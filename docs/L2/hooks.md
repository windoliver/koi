# @koi/hooks

> Hook loader, schema validation, and session-scoped hook lifecycle management.

## Layer

L2 — depends on `@koi/core` (L0) and `@koi/validation` (L0u).

## Purpose

Parses hook definitions from config, validates them against Zod schemas,
and manages session-scoped hook registration/cleanup. Hooks are side-effect
triggers (run a command, call a URL) that fire in response to session lifecycle
events.

> **Phase 1 scope (standalone API):** This package provides the loader,
> schema, registry, and executor as standalone APIs. `AgentManifest` does
> not yet include a `hooks` field — that will be added when the engine-level
> hook dispatch integration ships. Until then, callers use `loadHooks()` /
> `createHookRegistry()` / `executeHooks()` directly.

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

## Hook Types

### Phase 1 (this package)

| Type | Trigger | Transport |
|------|---------|-----------|
| `command` | Shell command via `Bun.spawn` | Local process |
| `http` | HTTP POST/PUT to a URL | Network |

### Deferred

| Type | Notes |
|------|-------|
| `prompt` | Requires model-call dependency surface; not included in Phase 1 |

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
2. **Execution** — `HookRegistry.execute()` dispatches matching hooks, enforcing
   session/agent identity on every call
3. **Cleanup** — `HookRegistry.cleanup(sessionId)` aborts in-flight hooks and
   removes registration. Idempotent — double-cleanup is a no-op.

## Security

- **HTTPS-only URLs** — HTTP loopback allowed only in dev mode (`NODE_ENV=development|test` or `KOI_DEV=1`)
- **No redirects** — `fetch()` uses `redirect: "error"` to prevent SSRF via 30x
- **Strict env-var expansion** — unresolved `${VAR}` in headers/secrets fails the hook
- **Trusted identity** — registry binds `agentId` at registration and overwrites caller-supplied identity on execute

## Module Structure

| File | Responsibility |
|------|---------------|
| `schema.ts` | Zod schemas for hook config validation |
| `loader.ts` | `loadHooks()` — validate raw config → typed `HookConfig[]` |
| `registry.ts` | `HookRegistry` — session-scoped registration/cleanup |
| `executor.ts` | `executeHooks()` — parallel/serial dispatch with timeout |
| `filter.ts` | `matchesHookFilter()` — event/tool/channel matching |
| `env.ts` | `expandEnvVars()` — `${VAR}` substitution with strict validation |

## Dependencies

- `@koi/core` — `HookConfig`, `HookFilter`, `HookEvent`, `Result`, `KoiError`
- `@koi/validation` — `validateWith`, `zodToKoiError`
- `zod` — schema definitions
