# @koi/sandbox-stack — Unified Sandboxed Code Execution

Unified L3 bundle for all sandbox functionality: cloud provider dispatch, stack composition, timeout guards, code execution tools, subprocess executors, and sandbox middleware. One import for everything sandbox — replaces the former `@koi/sandbox-cloud` meta-package.

---

## What This Feature Enables

### Single Entry Point for the Entire Sandbox Domain

Before this merge, sandbox consumers needed to import from up to 10 separate packages: `@koi/sandbox-cloud` for provider dispatch, individual adapter packages, `@koi/code-executor` for script tools, `@koi/sandbox-executor` for subprocess execution, and `@koi/middleware-sandbox` for interception. Now everything is available from one import:

```typescript
import {
  // Stack composition
  createSandboxStack,
  createExecuteCodeProvider,
  createTimeoutGuardedExecutor,

  // Cloud dispatch — select provider by name string
  createCloudSandbox,

  // Direct adapter access (lazy-loaded — install provider package first)
  createCloudflareAdapter,
  createDaytonaAdapter,
  createDockerAdapter,
  createE2bAdapter,
  createVercelAdapter,

  // Cloud-base utilities
  classifyCloudError,
  createCachedBridge,
  createCloudInstance,

  // Code execution tools
  createCodeExecutorProvider,
  createExecuteScriptTool,
  executeScript,

  // Subprocess executors
  createSubprocessExecutor,
  createPromotedExecutor,
  detectSandboxPlatform,

  // Sandbox middleware
  createSandboxMiddleware,
  sandboxMiddlewareDescriptor,
  validateSandboxMiddlewareConfig,
} from "@koi/sandbox-stack";
```

### Manifest-Driven Provider Selection

Agent manifests can declare a sandbox provider by name. The runtime reads the `provider` field and dispatches without conditional imports:

```yaml
# agent.koi.yaml
sandbox:
  provider: docker
  # ... provider-specific config fields
```

```typescript
import { createCloudSandbox } from "@koi/sandbox-stack";
import type { CloudSandboxConfig } from "@koi/sandbox-stack";

const result = await createCloudSandbox(manifestSandboxConfig as CloudSandboxConfig);
if (result.ok) {
  const adapter = result.value; // SandboxAdapter — ready for createSandboxStack()
}
```

### Docker Adapter Now Included in Cloud Dispatch

The former `@koi/sandbox-cloud` only dispatched to 4 cloud providers (Cloudflare, Daytona, E2B, Vercel). Docker was excluded despite using the same `sandbox-cloud-base` pattern. The unified `createCloudSandbox()` now dispatches to all 5 providers:

```
createCloudSandbox({ provider, ...config })
       │
       ├─ "cloudflare" → createCloudflareAdapter()
       ├─ "daytona"    → createDaytonaAdapter()
       ├─ "docker"     → createDockerAdapter()      ← NEW
       ├─ "e2b"        → createE2bAdapter()
       └─ "vercel"     → createVercelAdapter()
```

### Fewer Packages = Simpler Coordination

Reducing from 2 L3 meta-packages to 1 eliminates a coordination problem: consumers no longer need to decide whether to import from `@koi/sandbox-cloud` or `@koi/sandbox-stack`. The dependency graph is simpler, and there's one place to look for sandbox-related exports.

### Full Sandbox Pipeline from One Package

A complete sandbox pipeline — from provider selection to code execution to middleware interception — can now be assembled using only `@koi/sandbox-stack`:

```typescript
import {
  createCloudSandbox,
  createSandboxStack,
  createExecuteCodeProvider,
  createSandboxMiddleware,
} from "@koi/sandbox-stack";

// 1. Select provider from manifest config (async — lazy-loads the provider package)
const adapterResult = await createCloudSandbox({ provider: "docker", image: "node:20" });
if (!adapterResult.ok) throw new Error(adapterResult.error.message);

// 2. Compose into stack with timeout guard
const stack = createSandboxStack({
  adapter: adapterResult.value,
  resources: { timeoutMs: 30_000 },
});

// 3. Register as agent tool
const provider = createExecuteCodeProvider(stack);

// 4. Add middleware for interception
const middleware = createSandboxMiddleware({ /* config */ });
```

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
- Cloud dispatch and stack composition lived in separate L3 packages

---

## Architecture

`@koi/sandbox-stack` is an **L3 meta-package** — it composes L0u utilities with L2 adapters, executors, and middleware. No new logic beyond dispatch and coordination.

```
┌───────────────────────────────────────────────────────┐
│  @koi/sandbox-stack  (L3)                             │
│                                                       │
│  types.ts                  ← stack config + types     │
│  cloud-types.ts            ← CloudSandboxConfig union │
│  timeout-guard.ts          ← Promise.race wrapper     │
│  create-sandbox-stack.ts   ← stack factory            │
│  create-cloud-sandbox.ts   ← cloud dispatch factory   │
│  execute-code-tool.ts      ← ComponentProvider        │
│  index.ts                  ← public API surface       │
│                                                       │
├───────────────────────────────────────────────────────┤
│  Dependencies                                         │
│                                                       │
│  @koi/core                (L0)  Types, interfaces     │
│  @koi/sandbox-cloud-base  (L0u) Bridge, profiles      │
│  @koi/sandbox-cloudflare  (L2)  Lazy-loaded shim      │
│  @koi/sandbox-daytona     (L2)  Lazy-loaded shim      │
│  @koi/sandbox-docker      (L2)  Lazy-loaded shim      │
│  @koi/sandbox-e2b         (L2)  Lazy-loaded shim      │
│  @koi/sandbox-vercel      (L2)  Lazy-loaded shim      │
│  @koi/code-executor       (L2)  Code execution tools  │
│  @koi/sandbox-executor    (L2)  Subprocess executors  │
│  @koi/middleware-sandbox   (L2)  Sandbox middleware    │
└───────────────────────────────────────────────────────┘
```

---

## How It Works

### Stack Factory Pipeline

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

### Cloud Dispatch Factory

```
  await createCloudSandbox({ provider: "docker", ... })
         │
         ▼
  ┌──────────────────────────────────┐
  │ switch (config.provider)         │
  │   "cloudflare" → lazy import    │
  │   "daytona"    → lazy import    │
  │   "docker"     → lazy import    │
  │   "e2b"        → lazy import    │
  │   "vercel"     → lazy import    │
  │   default      → VALIDATION err │
  └──────────────────────────────────┘
         │
         ▼
  Promise<Result<SandboxAdapter, KoiError>>
```

Each provider package is dynamically imported only when requested. If the package is not installed, an actionable error is thrown (e.g., "install: bun add @koi/sandbox-docker"). TypeScript exhaustiveness checking (via `never`) catches missing providers at compile time.

### Timeout Guard (Two-Layer)

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

### Stack Composition

#### `createSandboxStack(config: SandboxStackConfig): SandboxStack`

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

#### `createExecuteCodeProvider(stack: SandboxStack): ComponentProvider`

Creates a `ComponentProvider` that attaches an `execute_code` tool to any agent. The tool accepts `{ code: string, input?: string, timeoutMs?: number }`.

#### `createTimeoutGuardedExecutor(inner: SandboxExecutor, maxTimeoutMs: number): SandboxExecutor`

Low-level helper. Wraps any executor with `Promise.race` timeout enforcement.

### Cloud Dispatch

#### `createCloudSandbox(config: CloudSandboxConfig): Promise<Result<SandboxAdapter, KoiError>>`

Async dispatch factory. Lazy-loads the provider package and routes to the correct adapter based on `config.provider`.

Returns `{ ok: true, value: SandboxAdapter }` on success, `{ ok: false, error: KoiError }` with code `"VALIDATION"` for unknown providers. Throws with an actionable install message if the provider package is not installed.

#### Types

```typescript
type CloudSandboxConfig =
  | { readonly provider: "cloudflare" } & CloudflareAdapterConfig
  | { readonly provider: "daytona" } & DaytonaAdapterConfig
  | { readonly provider: "docker" } & DockerAdapterConfig
  | { readonly provider: "e2b" } & E2bAdapterConfig
  | { readonly provider: "vercel" } & VercelAdapterConfig;

type CloudSandboxProvider = "cloudflare" | "daytona" | "docker" | "e2b" | "vercel";
```

### Lazy-Loaded Adapter Factories

Each factory lazy-loads its backend package on first call. Install the provider package to use:

| Factory | Provider Package | Install |
|---------|-----------------|---------|
| `createCloudflareAdapter` | `@koi/sandbox-cloudflare` | `bun add @koi/sandbox-cloudflare` |
| `createDaytonaAdapter` | `@koi/sandbox-daytona` | `bun add @koi/sandbox-daytona` |
| `createDockerAdapter` | `@koi/sandbox-docker` | `bun add @koi/sandbox-docker` |
| `createE2bAdapter` | `@koi/sandbox-e2b` | `bun add @koi/sandbox-e2b` |
| `createVercelAdapter` | `@koi/sandbox-vercel` | `bun add @koi/sandbox-vercel` |

### Re-Exported Cloud Base Utilities

| Export | Kind | Description |
|--------|------|-------------|
| `createCachedBridge` | function | SandboxAdapter → SandboxExecutor with TTL keep-alive |
| `classifyCloudError` | function | Cloud errors → `SandboxErrorCode` |
| `createCloudInstance` | function | Shared exec/readFile/writeFile/destroy |
| `BridgeConfig` | type | Bridge configuration |
| `CachedExecutor` | type | Executor with cache lifecycle |
| `ClassifiedError` | type | Classified error result |
| `CloudInstanceConfig` | type | Cloud instance factory config |
| `CloudSdkSandbox` | type | Minimal SDK shape all providers implement |

### Re-Exported Code Executor

| Export | Kind | Description |
|--------|------|-------------|
| `createCodeExecutorProvider` | function | ComponentProvider for code execution tool |
| `createExecuteScriptTool` | function | Tool descriptor + executor for scripts |
| `executeScript` | function | Direct script execution |
| `ConsoleEntry` | type | Console output entry |
| `ScriptConfig` | type | Script execution config |
| `ScriptResult` | type | Script execution result |

### Re-Exported Sandbox Executor

| Export | Kind | Description |
|--------|------|-------------|
| `createSubprocessExecutor` | function | Subprocess-based SandboxExecutor |
| `createPromotedExecutor` | function | Elevated-privilege executor |
| `detectSandboxPlatform` | function | Detect available sandbox platform |
| `SandboxPlatform` | type | Platform detection result |

### Re-Exported Sandbox Middleware

| Export | Kind | Description |
|--------|------|-------------|
| `createSandboxMiddleware` | function | KoiMiddleware for sandbox interception |
| `sandboxMiddlewareDescriptor` | object | Middleware descriptor metadata |
| `validateSandboxMiddlewareConfig` | function | Config validation |
| `DEFAULT_OUTPUT_LIMIT_BYTES` | constant | Default output byte limit |
| `DEFAULT_SKIP_TIERS` | constant | Trust tiers that skip sandbox |
| `DEFAULT_TIMEOUT_GRACE_MS` | constant | Grace period for timeout cleanup |
| `SandboxMiddlewareConfig` | type | Middleware config type |

---

## Examples

### Select provider from manifest config

```typescript
import { createCloudSandbox, createSandboxStack } from "@koi/sandbox-stack";

const adapterResult = await createCloudSandbox({
  provider: "e2b",
  apiKey: process.env["E2B_API_KEY"],
});

if (adapterResult.ok) {
  const stack = createSandboxStack({
    adapter: adapterResult.value,
    resources: { timeoutMs: 30_000 },
  });

  await stack.warmup();
  const result = await stack.executor.execute("console.log('hi')", null, 5000);
  await stack.dispose();
}
```

### Docker sandbox

```typescript
import { createSandboxStack, createDockerAdapter } from "@koi/sandbox-stack";

const stack = createSandboxStack({
  adapter: createDockerAdapter({ client, image: "python:3.12" }),
  resources: { timeoutMs: 10_000 },
});

const result = await stack.executor.execute("print('hello')", null, 5000);
await stack.dispose();
```

### Cloud backend with warmup

```typescript
import { createSandboxStack, createE2bAdapter } from "@koi/sandbox-stack";

const stack = createSandboxStack({
  adapter: createE2bAdapter({ apiKey: "...", client: e2bSdk }),
  resources: { timeoutMs: 30_000, maxMemoryMb: 1024 },
  idleTtlMs: 120_000,
});

await stack.warmup();
await stack.executor.execute("echo 'fast'", null, 5000);

// Direct file access on the running sandbox
await stack.instance?.writeFile("/tmp/data.json", encoder.encode('{"key":"value"}'));

await stack.dispose();
```

### Register as agent tool

```typescript
import { createSandboxStack, createExecuteCodeProvider } from "@koi/sandbox-stack";

const stack = createSandboxStack({ adapter: myAdapter, resources: { timeoutMs: 30_000 } });
const provider = createExecuteCodeProvider(stack);

const runtime = await createKoi({
  manifest,
  adapter: engineAdapter,
  providers: [provider],
});
```

### Network-enabled sandbox

```typescript
import { createSandboxStack } from "@koi/sandbox-stack";

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
| Merge sandbox-cloud into sandbox-stack | Eliminates a coordination problem — one L3 instead of two for the same domain. Docker was excluded from cloud dispatch; now included |
| Adapter injection (BYO) for stack | Stack doesn't know or care which backend — zero coupling to cloud SDKs. Users pick their adapter, stack composes it |
| Lazy-load shims for cloud dispatch | Provider packages are dynamically imported only when their adapter is requested. Avoids eager imports of optional devDependencies and keeps install footprint minimal |
| Discriminated union with `provider` field | Manifest-friendly — string-based selection. TypeScript exhaustiveness checking catches missing providers |
| Synchronous stack factory | No I/O at creation time. Lazy provisioning via bridge means `createSandboxStack()` is instant |
| Two-layer timeout | L3 guard catches hung bridges. Bridge guard passes clamped timeout to adapter. Defense in depth |
| `instance` as live getter | Lazy — returns `undefined` until warmup/first execute. No wasted provisioning |
| `dispose()` is idempotent | Safe to call multiple times. Matches Koi's immutable/safe-by-default patterns |
| Default 30s timeout + 60s TTL | Sane defaults for interactive use. Configurable for batch/long-running scenarios |
| `execute_code` as ComponentProvider | Standard Koi ECS pattern — tool attaches to agent during assembly, not hardwired |
| Renamed re-exports for clarity | `descriptor` → `sandboxMiddlewareDescriptor`, `validateConfig` → `validateSandboxMiddlewareConfig` to avoid name collisions |

---

## Testing

```
create-sandbox-stack.test.ts — 16 tests
  Stack factory, timeout guard, instance lifecycle, warmup, dispose, config mapping

timeout-guard.test.ts — 5 tests
  Pass-through, TIMEOUT error, clamp, result preservation, durationMs

execute-code-tool.test.ts — 6 tests
  ComponentProvider shape, delegation, success/error, default timeout, schema

create-cloud-sandbox.test.ts — 6 tests
  Dispatch to all 5 providers + validation error for unknown provider

__tests__/exports.test.ts — 23 tests
  Verifies all 24 runtime exports by name and type
```

```bash
bun --cwd packages/meta/sandbox-stack test
# 60 pass, 0 fail
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
                                         │             │
L2  @koi/sandbox-{cloudflare,daytona,   │             │
    docker,e2b,vercel} (lazy-loaded)     │             │
L2  @koi/code-executor                  │             │
L2  @koi/sandbox-executor               │             │
L2  @koi/middleware-sandbox              │             │
                                         ▼             ▼
L3  @koi/sandbox-stack ◄────────────────────────────────
    imports from L0 + L0u + L2 (valid for L3)
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L3 packages
    ✓ All interface properties readonly
    ✓ Immutable patterns
    ✓ import type for type-only imports
    ✓ .js extensions on all local imports
    ✓ No enum, any, namespace, as Type, !
```
