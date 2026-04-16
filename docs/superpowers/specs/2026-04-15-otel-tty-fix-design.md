# Design: Fix OTel Console Exporter + TTY Crash (#1770)

## Bug 1: OTel spans silent — zero spans emitted with KOI_OTEL_ENABLED=true

### Root Cause

`observability.ts` creates the middleware via `createOtelMiddleware({})`, which calls
`trace.getTracer()` from `@opentelemetry/api`. Without a registered `TracerProvider`,
this returns a no-op tracer. The CLI never initializes one — no `BasicTracerProvider`,
no exporter, no processor anywhere in the CLI codebase.

### Proposed Fix: Shared CLI bootstrap helper

New file: `packages/meta/cli/src/otel-bootstrap.ts`

- Exports `initOtelSdk(mode: "tui" | "headless")` function
- Creates `BasicTracerProvider` + `BatchSpanProcessor` (not Simple — see rationale)
- Exporter selection by mode:
  - `"headless"` (`koi start`): `ConsoleSpanExporter` to stderr — safe, no renderer conflict
  - `"tui"`: Respects `OTEL_TRACES_EXPORTER` env var:
    - `"otlp"` (default for TUI): OTLP exporter to localhost collector
    - `"console"`: `ConsoleSpanExporter` — only when user explicitly opts in (they must redirect stderr)
    - Unset/other: OTLP to localhost (safe default that doesn't corrupt TUI)
- Registers globally via `trace.setGlobalTracerProvider()`
- Returns `{ shutdown: () => Promise<void> }` for graceful flush + cleanup
- Called from **both** `tui-command.ts` and `start.ts` before `createKoiRuntime()`,
  gated on `KOI_OTEL_ENABLED=true`

### Why BatchSpanProcessor, not Simple?

`@koi/middleware-otel`'s `onStep` callback is documented as synchronous, CPU-only,
no-I/O. It runs in the event-trace hot path. `SimpleSpanProcessor` exports synchronously
on every `span.end()` — that puts console/network I/O directly into the hot path,
violating the contract. `BatchSpanProcessor` buffers spans and flushes asynchronously
on a timer, keeping `span.end()` cheap.

### Why CLI and not middleware-otel?

- middleware-otel depends on `@opentelemetry/api` only (lightweight, SDK-free)
- SDK initialization is an application concern, not a library concern
- Users who bring their own TracerProvider (OTLP collector, Datadog, etc.) should not
  get a conflicting default exporter
- CLI is the right place for env-var-driven defaults

### Rejected Alternatives

1. **Bootstrap inside observability stack** — Couples a library preset stack to SDK
   classes. Conflicts with user-provided providers.
2. **Bootstrap only in tui-command.ts** — `koi start` also uses `createKoiRuntime`
   with `otel: true` and would silently no-op. Both hosts must share the bootstrap.
3. **SimpleSpanProcessor + ConsoleSpanExporter** — Synchronous I/O in the hot path
   violates `onStep` contract. Console output corrupts TUI renderer.

## Bug 2: TTY crash when stderr is redirected (setRawMode errno 2)

### Root Cause

`create-app.ts:514` calls `activeRenderer.destroy()` without error handling. When
stdin fd is invalid (common when stderr is redirected via `2>file`), the renderer's
internal `setRawMode(false)` call throws with errno 2 (ENOENT/EBADF).

### Proposed Fix: Narrow catch for EBADF/ENOENT only

```typescript
if (activeRenderer !== undefined && injectedRenderer === undefined) {
  try {
    activeRenderer.destroy();
  } catch (e: unknown) {
    // renderer.destroy() may throw EBADF/ENOENT when stdin fd is invalid
    // (e.g. stderr redirected, tmux detach). Suppress only that case.
    const isRawModeError =
      e instanceof Error &&
      /setRawMode|EBADF|ENOENT|errno: 2/.test(e.message);
    if (!isRawModeError) throw e;
  }
}
```

This preserves visibility for real renderer teardown bugs (native crashes, partial
cleanup, terminal-state restoration failures) while suppressing only the known
stdin-fd-invalid case.

### Why not monkey-patch setRawMode (archive v1 approach)?

The archive v1 monkey-patched `process.stdin.setRawMode`. This works but:
- Mutates a global object
- Affects all code in the process, not just the renderer
- A narrowly-scoped catch at the call site is sufficient and safer

### Why not blanket catch {}?

Swallowing all exceptions from `destroy()` hides real renderer regressions, partial
teardown, or terminal-state restoration failures. The code still clears
`activeRenderer`, releases keepalive, and resolves `done()` — false-success shutdowns
make leaked state very hard to debug.

## Changes Summary

| Change | File | What |
|--------|------|------|
| OTel bootstrap | New: `packages/meta/cli/src/otel-bootstrap.ts` | `initOtelSdk(mode)` — shared helper, BatchSpanProcessor, mode-aware exporter |
| OTel wiring (TUI) | `packages/meta/cli/src/tui-command.ts` | Call `initOtelSdk("tui")` before runtime creation |
| OTel wiring (start) | `packages/meta/cli/src/commands/start.ts` | Call `initOtelSdk("headless")` before runtime creation |
| TTY guard | `packages/ui/tui/src/create-app.ts:514` | Narrow catch for EBADF/ENOENT on `destroy()` |
| Tests | `otel-bootstrap.test.ts` | Provider registered, BatchSpanProcessor used, mode-aware exporter selection |
| Tests | `create-app.test.ts` | Regression: EBADF suppressed, other errors propagate |

## Dependencies

- New: `@opentelemetry/sdk-trace-base` in `packages/meta/cli/package.json`
- New (optional): `@opentelemetry/exporter-trace-otlp-http` for OTLP export in TUI mode
- Existing: `@opentelemetry/api` already in middleware-otel
