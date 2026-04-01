# @koi/hooks

> Hook loader, schema validation, and session-scoped hook lifecycle management.

## Layer

L2 — depends on `@koi/core` (L0) and `@koi/validation` (L0u).

## Purpose

Parses hook definitions from agent config, validates them against Zod schemas,
and manages session-scoped hook registration/cleanup. Hooks are side-effect
triggers (run a command, call a URL) that fire in response to session lifecycle
events.

> **Phase 1 scope:** This package provides the loader, schema, registry, and
> executor APIs. Engine-level integration (automatic loading from
> `AgentManifest.hooks` and dispatch during session lifecycle) is not yet
> wired — callers must use `loadHooks()` / `createHookRegistry()` / 
> `executeHooks()` explicitly until the engine integration ships.

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

Hooks are declared in `AgentManifest.hooks`:

```yaml
hooks:
  - kind: command
    name: on-session-start
    cmd: ["./scripts/on-session-start.sh"]
    filter:
      events: ["session.started"]
    timeoutMs: 10000

  - kind: http
    name: notify-backend
    url: https://api.example.com/hooks
    method: POST
    headers:
      Authorization: "Bearer ${HOOK_TOKEN}"
    secret: "${WEBHOOK_SECRET}"
    filter:
      events: ["session.started", "session.ended"]
    timeoutMs: 5000
```

### Filter Syntax

Filters control which events trigger a hook. All filter fields use AND logic
(all specified conditions must match). Within a field, values use OR logic
(any value can match).

| Field | Type | Description |
|-------|------|-------------|
| `events` | `string[]` | Session event kinds (e.g., `"session.started"`) |
| `tools` | `string[]` | Tool names to match |
| `channels` | `string[]` | Channel IDs to match |

When no filter is specified, the hook fires on all events.

## Execution Model

- **Parallel by default** — matching hooks run via `Promise.allSettled`
- **Serial opt-in** — set `serial: true` on a hook config for ordered execution
- **Per-hook timeout** — `AbortSignal.timeout(hook.timeoutMs)` composed with
  session signal via `AbortSignal.any()`
- **Failure isolation** — one hook's failure never blocks others (parallel) or
  aborts the session

## Session Lifecycle

1. **Registration** — `loadHooks()` validates config, `HookRegistry.register()`
   binds hooks to a session ID
2. **Execution** — `executeHooks()` dispatches matching hooks for a given event
3. **Cleanup** — `HookRegistry.cleanup(sessionId)` aborts in-flight hooks and
   releases resources. Uses `AsyncDisposableStack` for reverse-order cleanup.
4. **Idempotent** — double-cleanup is a no-op

## Module Structure

| File | Responsibility |
|------|---------------|
| `schema.ts` | Zod schemas for hook config validation |
| `loader.ts` | `loadHooks()` — validate raw config → typed `HookConfig[]` |
| `registry.ts` | `HookRegistry` — session-scoped registration/cleanup |
| `executor.ts` | `executeHooks()` — parallel/serial dispatch with timeout |
| `filter.ts` | `matchesHookFilter()` — event/tool/channel matching |

## Dependencies

- `@koi/core` — `HookConfig`, `HookFilter`, `SessionContext`, `Result`, `KoiError`
- `@koi/validation` — `validateWith`, `zodToKoiError`
- `zod` — schema definitions
