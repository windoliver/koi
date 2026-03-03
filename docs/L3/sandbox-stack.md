# @koi/sandbox-stack — One-Call Sandboxed Code Execution

Composition bundle that gives any agent a `createSandboxStack()` factory: one call to get a timeout-guarded executor, optional direct instance access, warmup, and an `execute_code` tool provider. Backend is BYO via adapter injection — works with Docker, E2B, Cloudflare, Daytona, Vercel, or any `SandboxAdapter`.

---

## Why It Exists

Koi has 6 sandbox backends (OS, Docker, E2B, Cloudflare, Daytona, Vercel), each producing a `SandboxAdapter`. But wiring an adapter into a usable execution stack requires:

1. **Bridge setup** — `createCachedBridge()` with profile, TTL, and adapter
2. **Timeout enforcement** — clamping caller timeouts to configured maximums
3. **Instance lifecycle** — warmup, idle TTL, destroy
4. **Tool registration** — wrapping the executor as a `ComponentProvider` for agent assembly

Without this package:
- Every agent integration repeats ~50 lines of boilerplate wiring
- Timeout enforcement is inconsistent (some callers forget)
- No standard `execute_code` tool — each integration invents its own
- Warmup and instance access patterns differ per integration

---

## Architecture

`@koi/sandbox-stack` is an **L3 meta-package** — it composes L0u (`sandbox-cloud-base`) with any L2 adapter. No new logic beyond coordination.

```
┌─────────────────────────────────────────────────┐
│  @koi/sandbox-stack  (L3)                       │
│                                                 │
│  types.ts               ← config + bundle types │
│  timeout-guard.ts       ← Promise.race wrapper  │
│  create-sandbox-stack.ts ← main factory         │
│  execute-code-tool.ts   ← ComponentProvider     │
│  index.ts               ← public API surface    │
│                                                 │
├─────────────────────────────────────────────────┤
│  Dependencies                                   │
│                                                 │
│  @koi/core               (L0)  Types, interfaces│
│  @koi/sandbox-cloud-base (L0u) Bridge, profiles │
└─────────────────────────────────────────────────┘

  Adapter injected at call site — no direct dependency on
  Docker, E2B, Cloudflare, Daytona, or Vercel packages.
```

---

## What This Enables

```
BEFORE: Manual wiring (~50 lines per integration)
═════════════════════════════════════════════════

import { createCachedBridge } from "@koi/sandbox-cloud-base";
import { createDockerAdapter } from "@koi/sandbox-docker";

const adapter = createDockerAdapter({ client, image: "node:20" });

const bridge = createCachedBridge({
  adapter,
  profile: {
    resources: { timeoutMs: 30_000, memoryMb: 512 },
    network: { allow: false },
  },
  ttlMs: 60_000,
});

// Manual timeout enforcement
const execute = async (code, input, timeout) => {
  const clamped = Math.min(timeout, 30_000);
  return Promise.race([
    bridge.execute(code, input, clamped),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), clamped)
    ),
  ]);
};

// Manual tool registration
const tool = {
  descriptor: { name: "execute_code", ... },
  execute: async (args) => { ... },
};

// Manual warmup
await bridge.warmup?.();

// Manual cleanup
await bridge.dispose();


AFTER: One factory call
══════════════════════

import { createSandboxStack } from "@koi/sandbox-stack";
import { createDockerAdapter } from "@koi/sandbox-docker";

const stack = createSandboxStack({
  adapter: createDockerAdapter({ client, image: "node:20" }),
  resources: { timeoutMs: 30_000 },
});

await stack.warmup();
const result = await stack.executor.execute(code, null, 5000);
await stack.dispose();
```

---

## How It Works

### Factory Pipeline

```
  createSandboxStack(config)
         │
         ▼
  ┌─────────────────────────────────┐
  │ 1. mapConfigToProfile()         │
  │    config → SandboxProfile      │
  └──────────────┬──────────────────┘
                 │
                 ▼
  ┌─────────────────────────────────┐
  │ 2. createCachedBridge()         │
  │    adapter + profile + TTL      │
  │    → CachedExecutor             │
  └──────────────┬──────────────────┘
                 │
                 ▼
  ┌─────────────────────────────────┐
  │ 3. createTimeoutGuardedExecutor │
  │    Promise.race(exec, timeout)  │
  └──────────────┬──────────────────┘
                 │
                 ▼
  ┌─────────────────────────────────┐
  │ SandboxStack                    │
  │                                 │
  │ executor  ← guarded executor    │
  │ instance  ← live getter (lazy)  │
  │ warmup()  ← eager provisioning  │
  │ dispose() ← cleanup             │
  └─────────────────────────────────┘
```

### Timeout Guard (Two-Layer)

Timeout enforcement happens at two levels:

```
Caller timeout (e.g. 5000ms)
        │
        ▼
┌───────────────────────────────┐
│ L3: createTimeoutGuardedExecutor │
│ effectiveTimeout = min(5000, 30000) = 5000ms │
│ Promise.race(inner.execute(), timeoutPromise) │
└───────────────┬───────────────┘
                │
                ▼
┌───────────────────────────────┐
│ L0u: CachedBridge             │
│ Profile timeout clamp         │
│ (second guard for defense)    │
└───────────────────────────────┘
```

The L3 guard catches cases where the bridge itself hangs. The bridge guard passes the clamped timeout to the adapter. Both use `Math.min(callerTimeout, configTimeout)`.

### Instance Access

`stack.instance` is a live getter — it returns `undefined` before warmup or first execution, and the cached `SandboxInstance` after:

```
stack.instance     → undefined  (cold)
await stack.warmup()
stack.instance     → SandboxInstance { exec, readFile, writeFile, destroy }
```

This enables direct file I/O and multi-command sessions on backends that support it (Docker, E2B, cloud VMs). WASM-only adapters return `undefined`.

---

## API Reference

### `createSandboxStack(config: SandboxStackConfig): SandboxStack`

Main factory. Synchronous — no I/O until `warmup()` or first `execute()`.

**Config fields:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `adapter` | `SandboxAdapter` | (required) | Any L2 sandbox adapter |
| `resources.timeoutMs` | `number` | `30_000` | Max execution timeout |
| `resources.maxMemoryMb` | `number` | — | Passed to profile |
| `resources.maxOutputBytes` | `number` | — | Passed to profile |
| `network.allow` | `boolean` | `false` | Enable network access |
| `network.allowedHosts` | `readonly string[]` | — | Allowed hostnames |
| `idleTtlMs` | `number` | `60_000` | Idle time before instance teardown |

**Returns `SandboxStack`:**

| Field | Type | Description |
|-------|------|-------------|
| `executor` | `SandboxExecutor` | Timeout-guarded executor |
| `instance` | `SandboxInstance \| undefined` | Live getter for direct access |
| `warmup()` | `() => Promise<void>` | Eager instance provisioning |
| `dispose()` | `() => Promise<void>` | Release all resources (idempotent) |

### `createExecuteCodeProvider(stack: SandboxStack): ComponentProvider`

Creates a `ComponentProvider` that attaches an `execute_code` tool to any agent.

```typescript
import { createExecuteCodeProvider } from "@koi/sandbox-stack";

const provider = createExecuteCodeProvider(stack);
// → ComponentProvider with tool: execute_code
```

The tool accepts `{ code: string, input?: string, timeoutMs?: number }` and returns the execution result.

### `createTimeoutGuardedExecutor(inner: SandboxExecutor, maxTimeoutMs: number): SandboxExecutor`

Low-level helper. Wraps any executor with `Promise.race` timeout enforcement.

### Key Types

```typescript
interface SandboxStackConfig {
  readonly adapter: SandboxAdapter;
  readonly resources?: {
    readonly timeoutMs?: number;
    readonly maxMemoryMb?: number;
    readonly maxOutputBytes?: number;
  };
  readonly network?: {
    readonly allow?: boolean;
    readonly allowedHosts?: readonly string[];
  };
  readonly idleTtlMs?: number;
}

interface SandboxStack {
  readonly executor: SandboxExecutor;
  readonly instance: SandboxInstance | undefined;
  readonly warmup: () => Promise<void>;
  readonly dispose: () => Promise<void>;
}
```

---

## Examples

### Basic: Docker sandbox

```typescript
import { createSandboxStack } from "@koi/sandbox-stack";
import { createDockerAdapter } from "@koi/sandbox-docker";

const stack = createSandboxStack({
  adapter: createDockerAdapter({ client, image: "python:3.12" }),
  resources: { timeoutMs: 10_000 },
});

const result = await stack.executor.execute(
  "print('hello world')",
  null,
  5000,
);
// result.ok === true → result.value.output === "hello world\n"

await stack.dispose();
```

### Cloud backend with warmup

```typescript
import { createSandboxStack } from "@koi/sandbox-stack";
import { createE2bAdapter } from "@koi/sandbox-e2b";

const stack = createSandboxStack({
  adapter: createE2bAdapter({ apiKey: "...", client: e2bSdk }),
  resources: { timeoutMs: 30_000, maxMemoryMb: 1024 },
  idleTtlMs: 120_000,  // keep warm for 2 minutes
});

// Pre-warm to avoid cold start on first request
await stack.warmup();

// Multiple executions reuse the same sandbox instance
await stack.executor.execute("echo 'fast'", null, 5000);
await stack.executor.execute("echo 'also fast'", null, 5000);

// Direct file access on the running sandbox
await stack.instance?.writeFile("/tmp/data.json", encoder.encode('{"key":"value"}'));
const content = await stack.instance?.readFile("/tmp/data.json");

await stack.dispose();
```

### Register as agent tool

```typescript
import { createSandboxStack, createExecuteCodeProvider } from "@koi/sandbox-stack";

const stack = createSandboxStack({
  adapter: myAdapter,
  resources: { timeoutMs: 30_000 },
});

// Gives agents an `execute_code` tool
const provider = createExecuteCodeProvider(stack);

const runtime = await createKoi({
  manifest,
  adapter: engineAdapter,
  providers: [provider],
});
```

### Network-enabled sandbox

```typescript
const stack = createSandboxStack({
  adapter: myAdapter,
  resources: { timeoutMs: 60_000 },
  network: {
    allow: true,
    allowedHosts: ["api.github.com", "registry.npmjs.org"],
  },
});
```

---

## Backend Latency Characteristics

| Backend | Cold Start | Warm Call | Instance Model |
|---------|-----------|----------|----------------|
| OS/IPC (`@koi/sandbox`) | ~10-50ms | ~10-50ms | Per-call spawn |
| Docker (`@koi/sandbox-docker`) | ~500ms-2s | ~10-50ms | Cached container |
| E2B (`@koi/sandbox-e2b`) | ~2-10s | ~50-200ms | Cached cloud VM |
| Cloudflare (`@koi/sandbox-cloudflare`) | ~200ms-1s | ~10-50ms | Cached worker |
| Daytona (`@koi/sandbox-daytona`) | ~2-10s | ~50-200ms | Cached cloud VM |
| Vercel (`@koi/sandbox-vercel`) | ~200ms-1s | ~10-50ms | Cached serverless |

Use `warmup()` to absorb cold start latency before the first user-facing execution.

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Adapter injection (BYO) | Stack doesn't know or care which backend — zero coupling to cloud SDKs. Users pick their adapter, stack composes it |
| Synchronous factory | No I/O at creation time. Lazy provisioning via bridge means `createSandboxStack()` is instant |
| Two-layer timeout | L3 guard catches hung bridges. Bridge guard passes clamped timeout to adapter. Defense in depth |
| `instance` as live getter | Lazy — returns `undefined` until warmup/first execute. No wasted provisioning |
| `dispose()` is idempotent | Safe to call multiple times. Matches Koi's immutable/safe-by-default patterns |
| No direct adapter deps | `package.json` only depends on `@koi/core` + `@koi/sandbox-cloud-base`. Adapters are peer deps of the consuming code |
| Default 30s timeout + 60s TTL | Sane defaults for interactive use. Configurable for batch/long-running scenarios |
| `execute_code` as ComponentProvider | Standard Koi ECS pattern — tool attaches to agent during assembly, not hardwired |

---

## Testing

```
create-sandbox-stack.test.ts — 16 tests
  ● Factory returns correct SandboxStack shape
  ● executor.execute() delegates to adapter via bridge
  ● Timeout guard fires when code exceeds resources.timeoutMs
  ● Math.min(callerTimeout, configTimeout) applied
  ● instance undefined before warmup
  ● instance present after warmup
  ● warmup() calls adapter.create() eagerly
  ● warmup() no-op when already warm
  ● dispose() destroys instance
  ● dispose() idempotent
  ● execute() after dispose() returns CRASH error
  ● idleTtlMs passed to bridge
  ● Default config values applied
  ● Network config maps to profile
  ● Resources config maps to profile
  ● Profile maxOutputBytes maps correctly

timeout-guard.test.ts — 5 tests
  ● Passes through when within timeout
  ● Returns TIMEOUT error when exceeded
  ● Clamps caller timeout to max
  ● Original result returned unchanged
  ● Reports correct durationMs

execute-code-tool.test.ts — 6 tests
  ● Returns ComponentProvider with correct tool name
  ● Tool execute delegates to stack.executor
  ● Tool handles success result
  ● Tool handles error result
  ● Tool uses default timeout when not specified
  ● Tool descriptor has correct schema

__tests__/exports.test.ts — 4 tests
  ● createSandboxStack exported
  ● createExecuteCodeProvider exported
  ● createTimeoutGuardedExecutor exported
  ● SandboxStack type exported
```

```bash
bun --cwd packages/sandbox-stack test
# 29 pass, 0 fail, 100% coverage
```

---

## Layer Compliance

```
L0  @koi/core ──────────────────────────────────────┐
    SandboxAdapter, SandboxExecutor, SandboxInstance, │
    SandboxProfile, ComponentProvider, Tool,           │
    ToolDescriptor, TrustTier, JsonObject              │
                                                       │
L0u @koi/sandbox-cloud-base ────────────┐             │
    createCachedBridge, CachedExecutor,  │             │
    createTestProfile                    │             │
                                         ▼             │
L3  @koi/sandbox-stack ◄────────────────────────────────┘
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L3 packages
    ✗ never imports L2 adapter packages directly
    ✓ All interface properties readonly
    ✓ Immutable patterns
    ✓ import type for type-only imports
    ✓ .js extensions on all local imports
    ✓ No enum, any, namespace, as Type, !
```
