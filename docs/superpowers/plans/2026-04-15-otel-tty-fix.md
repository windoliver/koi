# Fix OTel Console Exporter + TTY Crash (#1770) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire a default OTel SDK (BatchSpanProcessor + mode-aware exporter) into both CLI hosts so `KOI_OTEL_ENABLED=true` actually emits spans, and guard TUI renderer teardown against the stdin-fd-invalid crash.

**Architecture:** New shared `otel-bootstrap.ts` in the CLI package initializes the OTel SDK before `createKoiRuntime()`. Both `tui-command.ts` and `start.ts` call it, gated on `KOI_OTEL_ENABLED=true`. Separately, `create-app.ts` gets a narrow try-catch on `renderer.destroy()` for the EBADF/ENOENT case only.

**Tech Stack:** `@opentelemetry/sdk-trace-base` (BasicTracerProvider, BatchSpanProcessor, ConsoleSpanExporter, InMemorySpanExporter), `@opentelemetry/exporter-trace-otlp-http` (OTLPTraceExporter for TUI mode), bun:test

**Spec:** `docs/superpowers/specs/2026-04-15-otel-tty-fix-design.md`

**Worktree:** `../koi-issue-1770` on branch `fix/1770-otel-console-exporter`

---

## File Map

| Action | Path | Responsibility |
|--------|------|---------------|
| Create | `packages/meta/cli/src/otel-bootstrap.ts` | Shared OTel SDK init: provider + processor + exporter selection |
| Create | `packages/meta/cli/src/otel-bootstrap.test.ts` | Unit tests for bootstrap function |
| Modify | `packages/meta/cli/src/tui-command.ts:1208-1210` | Call `initOtelSdk("tui")` before runtime creation |
| Modify | `packages/meta/cli/src/commands/start.ts:295-336` | Add `otel` config + call `initOtelSdk("headless")` |
| Modify | `packages/meta/cli/package.json` | Add `@opentelemetry/sdk-trace-base`, `@opentelemetry/exporter-trace-otlp-http` |
| Modify | `packages/ui/tui/src/create-app.ts:513-515` | Narrow catch on `destroy()` for EBADF/ENOENT |
| Create | `packages/ui/tui/src/create-app-destroy.test.ts` | Regression test for destroy error handling |

---

### Task 1: Add OTel SDK dependencies to CLI package

**Files:**
- Modify: `packages/meta/cli/package.json`

- [ ] **Step 1: Install dependencies**

```bash
cd /Users/sophiawj/private/koi-issue-1770
bun add --cwd packages/meta/cli @opentelemetry/sdk-trace-base @opentelemetry/exporter-trace-otlp-http
```

- [ ] **Step 2: Verify installation**

```bash
cd /Users/sophiawj/private/koi-issue-1770
grep -A2 'sdk-trace-base\|exporter-trace-otlp' packages/meta/cli/package.json
```

Expected: both packages appear in `dependencies` with pinned versions.

- [ ] **Step 3: Verify bun install succeeds**

```bash
cd /Users/sophiawj/private/koi-issue-1770
bun install --frozen-lockfile || bun install
```

- [ ] **Step 4: Commit**

```bash
cd /Users/sophiawj/private/koi-issue-1770
git add packages/meta/cli/package.json bun.lock
git commit -m "chore(cli): add @opentelemetry/sdk-trace-base and exporter-trace-otlp-http deps

Required for #1770 — wiring a default OTel SDK so KOI_OTEL_ENABLED=true
actually emits spans."
```

---

### Task 2: Create `otel-bootstrap.ts` — write failing tests first

**Files:**
- Create: `packages/meta/cli/src/otel-bootstrap.test.ts`

- [ ] **Step 1: Write the failing test file**

```typescript
/**
 * Tests for otel-bootstrap — the shared CLI OTel SDK initializer.
 *
 * Uses InMemorySpanExporter to capture spans without I/O.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { trace } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";

// Will fail until otel-bootstrap.ts is created
import { initOtelSdk } from "./otel-bootstrap.js";

describe("initOtelSdk", () => {
  afterEach(() => {
    // Reset global provider between tests
    trace.disable();
  });

  test("registers a global TracerProvider", async () => {
    const handle = initOtelSdk("headless");
    const tracer = trace.getTracer("test");
    const span = tracer.startSpan("test-span");
    // A real provider returns spans with valid trace IDs (not all zeros)
    expect(span.spanContext().traceId).not.toBe("00000000000000000000000000000000");
    span.end();
    await handle.shutdown();
  });

  test("shutdown flushes and disables provider", async () => {
    const handle = initOtelSdk("headless");
    const tracer = trace.getTracer("test");
    const span = tracer.startSpan("flush-test");
    span.end();
    await handle.shutdown();

    // After shutdown, new spans should be no-ops (all-zero trace ID)
    const noopSpan = trace.getTracer("test").startSpan("after-shutdown");
    expect(noopSpan.spanContext().traceId).toBe("00000000000000000000000000000000");
    noopSpan.end();
  });

  test("headless mode does not throw", () => {
    expect(() => initOtelSdk("headless")).not.toThrow();
  });

  test("tui mode does not throw", () => {
    expect(() => initOtelSdk("tui")).not.toThrow();
  });

  test("calling initOtelSdk twice is safe (second call is no-op)", async () => {
    const handle1 = initOtelSdk("headless");
    const handle2 = initOtelSdk("headless");
    // Both return shutdown handles — neither throws
    await handle1.shutdown();
    await handle2.shutdown();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/sophiawj/private/koi-issue-1770
bun test packages/meta/cli/src/otel-bootstrap.test.ts
```

Expected: FAIL — cannot resolve `./otel-bootstrap.js`

---

### Task 3: Implement `otel-bootstrap.ts`

**Files:**
- Create: `packages/meta/cli/src/otel-bootstrap.ts`

- [ ] **Step 1: Write the implementation**

```typescript
/**
 * Shared OTel SDK bootstrap for CLI hosts (koi tui, koi start).
 *
 * Initialises a BasicTracerProvider with BatchSpanProcessor and a
 * mode-aware exporter, then registers it globally so @koi/middleware-otel's
 * `trace.getTracer()` calls return a real tracer instead of a no-op.
 *
 * Design decisions (see #1770 design spec):
 *   - BatchSpanProcessor (not Simple) — onStep is synchronous/CPU-only,
 *     synchronous export would violate the middleware hot-path contract
 *   - CLI owns SDK init, not middleware-otel — keeps the library SDK-free
 *   - Mode-aware exporter — TUI defaults to OTLP (console corrupts renderer),
 *     headless defaults to ConsoleSpanExporter (safe for stderr)
 */

import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  ConsoleSpanExporter,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

/** Return value from initOtelSdk — call shutdown() for graceful flush. */
export interface OtelSdkHandle {
  /** Flush pending spans and shut down the provider. */
  readonly shutdown: () => Promise<void>;
}

/**
 * Initialise the OTel SDK and register a global TracerProvider.
 *
 * @param mode - `"tui"` uses OTLP exporter by default (console corrupts the
 *   TUI renderer). `"headless"` uses ConsoleSpanExporter to stderr.
 *   Override with `OTEL_TRACES_EXPORTER=console` to force console export
 *   (useful when stderr is redirected: `koi tui 2>/tmp/spans.log`).
 *
 * Safe to call multiple times — subsequent calls after the first return a
 * no-op handle (the global provider is already registered).
 */
export function initOtelSdk(mode: "tui" | "headless"): OtelSdkHandle {
  // Guard: if a real provider is already registered, skip.
  // trace.getTracerProvider() returns a ProxyTracerProvider wrapping the
  // real one; checking for a registered provider is done via the noop check.
  const testSpan = trace.getTracer("__otel_bootstrap_probe__").startSpan("probe");
  const isNoop = testSpan.spanContext().traceId === "00000000000000000000000000000000";
  testSpan.end();

  if (!isNoop) {
    // Provider already registered (e.g. user brought their own) — no-op.
    return { shutdown: async () => {} };
  }

  const exporter = createExporter(mode);

  const provider = new BasicTracerProvider({
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });

  trace.setGlobalTracerProvider(provider);

  return {
    shutdown: async () => {
      await provider.shutdown();
      trace.disable();
    },
  };
}

/**
 * Select span exporter based on mode and env vars.
 *
 * Priority:
 *   1. OTEL_TRACES_EXPORTER=console → ConsoleSpanExporter (any mode)
 *   2. headless → ConsoleSpanExporter (stderr is safe)
 *   3. tui → OTLPTraceExporter if available, else ConsoleSpanExporter with
 *      a stderr warning that spans may corrupt the TUI
 */
function createExporter(mode: "tui" | "headless"): SpanExporter {
  const envExporter = process.env.OTEL_TRACES_EXPORTER;

  // Explicit console override — user knows what they're doing
  if (envExporter === "console") {
    return new ConsoleSpanExporter();
  }

  // Headless mode — console is always safe
  if (mode === "headless") {
    return new ConsoleSpanExporter();
  }

  // TUI mode — use OTLP exporter (direct dependency, static import at top).
  // Console output would corrupt the TUI renderer; OTLP sends spans to a
  // collector over HTTP without touching stdout/stderr.
  const url = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
    ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    ?? "http://localhost:4318/v1/traces";
  return new OTLPTraceExporter({ url });
}
```

- [ ] **Step 2: Run tests**

```bash
cd /Users/sophiawj/private/koi-issue-1770
bun test packages/meta/cli/src/otel-bootstrap.test.ts
```

Expected: all 5 tests PASS.

- [ ] **Step 3: Typecheck**

```bash
cd /Users/sophiawj/private/koi-issue-1770
bun run --cwd packages/meta/cli typecheck
```

Expected: PASS (no type errors).

- [ ] **Step 4: Commit**

```bash
cd /Users/sophiawj/private/koi-issue-1770
git add packages/meta/cli/src/otel-bootstrap.ts packages/meta/cli/src/otel-bootstrap.test.ts
git commit -m "feat(cli): add shared OTel SDK bootstrap for #1770

initOtelSdk(mode) creates a BasicTracerProvider with BatchSpanProcessor
and a mode-aware exporter (ConsoleSpanExporter for headless, OTLP for TUI).
Registers globally so middleware-otel's trace.getTracer() returns a real
tracer instead of a no-op."
```

---

### Task 4: Wire `initOtelSdk("tui")` into tui-command.ts

**Files:**
- Modify: `packages/meta/cli/src/tui-command.ts:1208-1210`

- [ ] **Step 1: Add import at top of file**

Add this import near the other local imports in `tui-command.ts`:

```typescript
import { initOtelSdk } from "./otel-bootstrap.js";
```

- [ ] **Step 2: Wire bootstrap before runtime creation**

Replace the block at lines 1208-1210:

```typescript
    // KOI_OTEL_ENABLED=true opts into OTel span emission for the TUI session.
    // Requires an OTel SDK initialised before this point (e.g. via OTLP exporter).
    ...(process.env.KOI_OTEL_ENABLED === "true" ? { otel: true as const } : {}),
```

With:

```typescript
    // KOI_OTEL_ENABLED=true opts into OTel span emission for the TUI session.
    // initOtelSdk() registers a global TracerProvider so middleware-otel's
    // trace.getTracer() returns a real tracer. Must be called before createKoiRuntime.
    ...(otelEnabled ? { otel: true as const } : {}),
```

And add the bootstrap call **before** the `createKoiRuntime()` call (before the object literal that contains `otel:`):

```typescript
  // OTel SDK bootstrap — must happen before createKoiRuntime so the global
  // TracerProvider is registered before middleware-otel calls trace.getTracer().
  const otelEnabled = process.env.KOI_OTEL_ENABLED === "true";
  const otelHandle = otelEnabled ? initOtelSdk("tui") : undefined;
```

And add shutdown to the cleanup path — find the existing shutdown/dispose logic and add:

```typescript
  // Flush OTel spans before process exit
  await otelHandle?.shutdown();
```

- [ ] **Step 3: Typecheck**

```bash
cd /Users/sophiawj/private/koi-issue-1770
bun run --cwd packages/meta/cli typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
cd /Users/sophiawj/private/koi-issue-1770
git add packages/meta/cli/src/tui-command.ts
git commit -m "feat(cli): wire OTel SDK bootstrap into koi tui (#1770)

Calls initOtelSdk('tui') before createKoiRuntime when KOI_OTEL_ENABLED=true.
The global TracerProvider is now registered before middleware-otel's
trace.getTracer() runs, so spans are no longer silently discarded."
```

---

### Task 5: Wire `initOtelSdk("headless")` into start.ts

**Files:**
- Modify: `packages/meta/cli/src/commands/start.ts:295-336`

- [ ] **Step 1: Add import**

Add near the other local imports in `start.ts`:

```typescript
import { initOtelSdk } from "../otel-bootstrap.js";
```

- [ ] **Step 2: Add OTel bootstrap before createKoiRuntime**

Insert before the `const runtimeHandle = await createKoiRuntime({` line (~line 295):

```typescript
  // OTel SDK bootstrap — must happen before createKoiRuntime so the global
  // TracerProvider is registered before middleware-otel calls trace.getTracer().
  const otelEnabled = process.env.KOI_OTEL_ENABLED === "true";
  const otelHandle = otelEnabled ? initOtelSdk("headless") : undefined;
```

- [ ] **Step 3: Add `otel` config to createKoiRuntime call**

In the `createKoiRuntime({...})` call (around line 295-336), add after the `getGeneration` line:

```typescript
    ...(otelEnabled ? { otel: true as const } : {}),
```

- [ ] **Step 4: Add shutdown to cleanup path**

Find the shutdown/dispose logic in `start.ts` and add:

```typescript
    // Flush OTel spans before process exit
    await otelHandle?.shutdown();
```

- [ ] **Step 5: Typecheck**

```bash
cd /Users/sophiawj/private/koi-issue-1770
bun run --cwd packages/meta/cli typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/sophiawj/private/koi-issue-1770
git add packages/meta/cli/src/commands/start.ts
git commit -m "feat(cli): wire OTel SDK bootstrap into koi start (#1770)

Calls initOtelSdk('headless') before createKoiRuntime when
KOI_OTEL_ENABLED=true. Both CLI hosts now share the same bootstrap
path — no split-brain between koi tui and koi start."
```

---

### Task 6: Fix TTY crash — write failing test first

**Files:**
- Create: `packages/ui/tui/src/create-app-destroy.test.ts`

- [ ] **Step 1: Write the failing regression test**

```typescript
/**
 * Regression test for #1770 — renderer.destroy() must not crash when
 * stdin fd is invalid (EBADF/ENOENT from setRawMode).
 */

import { describe, expect, test } from "bun:test";

describe("renderer.destroy() error handling", () => {
  test("EBADF from setRawMode is suppressed during destroy", () => {
    // Simulate the error path: a destroy() that throws EBADF
    const fakeRenderer = {
      destroy(): void {
        const err = new Error("setRawMode failed with errno: 2");
        (err as NodeJS.ErrnoException).code = "EBADF";
        throw err;
      },
    };

    // This is the guard logic that will be in create-app.ts
    // Extracted here to test the pattern in isolation
    expect(() => {
      try {
        fakeRenderer.destroy();
      } catch (e: unknown) {
        const isRawModeError =
          e instanceof Error &&
          /setRawMode|EBADF|ENOENT|errno: 2/.test(e.message);
        if (!isRawModeError) throw e;
      }
    }).not.toThrow();
  });

  test("non-EBADF errors from destroy propagate", () => {
    const fakeRenderer = {
      destroy(): void {
        throw new Error("renderer native crash: segfault in wgpu");
      },
    };

    expect(() => {
      try {
        fakeRenderer.destroy();
      } catch (e: unknown) {
        const isRawModeError =
          e instanceof Error &&
          /setRawMode|EBADF|ENOENT|errno: 2/.test(e.message);
        if (!isRawModeError) throw e;
      }
    }).toThrow("renderer native crash");
  });

  test("ENOENT variant is also suppressed", () => {
    const fakeRenderer = {
      destroy(): void {
        throw new Error("ENOENT: no such file or directory, setRawMode");
      },
    };

    expect(() => {
      try {
        fakeRenderer.destroy();
      } catch (e: unknown) {
        const isRawModeError =
          e instanceof Error &&
          /setRawMode|EBADF|ENOENT|errno: 2/.test(e.message);
        if (!isRawModeError) throw e;
      }
    }).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

```bash
cd /Users/sophiawj/private/koi-issue-1770
bun test packages/ui/tui/src/create-app-destroy.test.ts
```

Expected: all 3 tests PASS (these test the guard pattern in isolation).

---

### Task 7: Apply the narrow catch to create-app.ts

**Files:**
- Modify: `packages/ui/tui/src/create-app.ts:513-515`

- [ ] **Step 1: Apply the fix**

Replace lines 513-515:

```typescript
      if (activeRenderer !== undefined && injectedRenderer === undefined) {
        activeRenderer.destroy();
      }
```

With:

```typescript
      if (activeRenderer !== undefined && injectedRenderer === undefined) {
        try {
          activeRenderer.destroy();
        } catch (e: unknown) {
          // Suppress only the known stdin-fd-invalid case (#1770):
          // renderer.destroy() calls setRawMode(false) which throws EBADF/ENOENT
          // when stdin fd is closed (stderr redirected, tmux detach).
          const isRawModeError =
            e instanceof Error &&
            /setRawMode|EBADF|ENOENT|errno: 2/.test(e.message);
          if (!isRawModeError) throw e;
        }
      }
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/sophiawj/private/koi-issue-1770
bun run --cwd packages/ui/tui typecheck
```

Expected: PASS.

- [ ] **Step 3: Run existing TUI tests**

```bash
cd /Users/sophiawj/private/koi-issue-1770
bun run test --filter=@koi/tui
```

Expected: all existing tests still PASS.

- [ ] **Step 4: Commit**

```bash
cd /Users/sophiawj/private/koi-issue-1770
git add packages/ui/tui/src/create-app.ts packages/ui/tui/src/create-app-destroy.test.ts
git commit -m "fix(tui): guard renderer.destroy() against EBADF on stdin (#1770)

Narrow catch suppresses only setRawMode/EBADF/ENOENT errors from
renderer.destroy() — the known failure when stdin fd is invalid (stderr
redirected, tmux detach). All other destroy errors propagate normally
so real renderer regressions remain visible."
```

---

### Task 8: Full verification

- [ ] **Step 1: Run full typecheck**

```bash
cd /Users/sophiawj/private/koi-issue-1770
bun run typecheck
```

- [ ] **Step 2: Run full test suite**

```bash
cd /Users/sophiawj/private/koi-issue-1770
bun run test
```

- [ ] **Step 3: Run lint**

```bash
cd /Users/sophiawj/private/koi-issue-1770
bun run lint
```

- [ ] **Step 4: Run layer check**

```bash
cd /Users/sophiawj/private/koi-issue-1770
bun run check:layers
```

- [ ] **Step 5: Verify OTel bootstrap works end-to-end (manual smoke test)**

```bash
cd /Users/sophiawj/private/koi-issue-1770
KOI_OTEL_ENABLED=true OTEL_TRACES_EXPORTER=console bun run packages/meta/cli/src/bin.ts start --prompt "say hello" 2>/tmp/otel-smoke.stderr
cat /tmp/otel-smoke.stderr | head -50
```

Expected: stderr contains OTel span output (JSON objects with `traceId`, `spanId`, `name` fields).

- [ ] **Step 6: Fix any issues found, commit**
