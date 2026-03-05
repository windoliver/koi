# @koi/sandbox-cloud — Cloud Sandbox Provider Dispatch

Single import for any cloud sandbox provider. Select backend by name string, or import provider factories directly. One `createCloudSandbox()` call dispatches to the correct adapter — manifest-friendly, no conditional imports needed.

---

## Why It Exists

Koi has 4 cloud sandbox backends (Cloudflare Workers, Daytona, E2B, Vercel), each as an independent L2 package. Without this meta-package:

1. **Consumers must know which package to import** — `@koi/sandbox-cloudflare` vs `@koi/sandbox-e2b` etc.
2. **Manifest-driven selection is awkward** — a YAML `provider: "e2b"` field requires the caller to write a switch/map from string → import
3. **Shared base utilities require a separate import** — `@koi/sandbox-cloud-base` bridge, error classification, and instance helpers aren't discoverable from provider packages
4. **No single place for cross-provider utilities** — future features like provider health checks, fallback chains, or cost routing have no natural home

With `@koi/sandbox-cloud`:

```
BEFORE: Conditional imports
═══════════════════════════

import { createCloudflareAdapter } from "@koi/sandbox-cloudflare";
import { createDaytonaAdapter } from "@koi/sandbox-daytona";
import { createE2bAdapter } from "@koi/sandbox-e2b";
import { createVercelAdapter } from "@koi/sandbox-vercel";

// Caller builds their own dispatcher
function getAdapter(provider: string, config: unknown) {
  switch (provider) {
    case "cloudflare": return createCloudflareAdapter(config);
    case "daytona":    return createDaytonaAdapter(config);
    // ...
  }
}


AFTER: One import, one call
════════════════════════════

import { createCloudSandbox } from "@koi/sandbox-cloud";

const result = createCloudSandbox({ provider: "e2b", client: e2bSdk });
```

---

## What This Enables

### Manifest-Driven Provider Selection

Agent manifests can declare a cloud sandbox provider by name. The runtime reads the `provider` field and dispatches without hardcoded imports:

```yaml
# agent.koi.yaml
sandbox:
  provider: cloudflare
  # ... provider-specific config fields
```

```typescript
import { createCloudSandbox } from "@koi/sandbox-cloud";
import type { CloudSandboxConfig } from "@koi/sandbox-cloud";

// Config loaded from manifest — provider field drives dispatch
const result = createCloudSandbox(manifestSandboxConfig as CloudSandboxConfig);
if (result.ok) {
  const adapter = result.value; // SandboxAdapter
}
```

### Single Entry Point for All Cloud Providers

```
┌──────────────────────────────────────────────────────┐
│  @koi/sandbox-cloud  (L3)                            │
│                                                      │
│  createCloudSandbox({ provider, ...config })         │
│         │                                            │
│         ├─ "cloudflare" → createCloudflareAdapter()  │
│         ├─ "daytona"    → createDaytonaAdapter()     │
│         ├─ "e2b"        → createE2bAdapter()         │
│         └─ "vercel"     → createVercelAdapter()      │
│                                                      │
│  Also re-exports:                                    │
│  · Individual provider factories (direct access)     │
│  · Provider config types                             │
│  · Cloud-base utilities (bridge, error classify)     │
└──────────────────────────────────────────────────────┘
```

### Exhaustive Provider Coverage

The `CloudSandboxConfig` discriminated union is exhaustive — TypeScript catches missing providers at compile time. Adding a new cloud backend requires adding one union member and one switch case.

---

## Architecture

`@koi/sandbox-cloud` is an **L3 meta-package** — it depends on L0, L0u, and L2 provider packages. No new logic beyond dispatch.

```
L0  @koi/core ─────────────────────────────────┐
    SandboxAdapter, KoiError, Result            │
                                                │
L0u @koi/sandbox-cloud-base ──────────┐        │
    createCachedBridge, classifyCloud- │        │
    Error, createCloudInstance         │        │
                                       │        │
L2  @koi/sandbox-cloudflare ──┐       │        │
L2  @koi/sandbox-daytona ─────┤       │        │
L2  @koi/sandbox-e2b ─────────┤       │        │
L2  @koi/sandbox-vercel ──────┤       │        │
                               ▼       ▼        ▼
L3  @koi/sandbox-cloud ◄──────────────────────────
    Dispatch factory + re-exports
```

### Internal Module Map

```
packages/meta/sandbox-cloud/
├── package.json
├── tsup.config.ts
├── tsconfig.json
└── src/
    ├── index.ts                     ← public API surface
    ├── types.ts                     ← CloudSandboxConfig union
    ├── create-cloud-sandbox.ts      ← dispatcher factory (~35 LOC)
    └── create-cloud-sandbox.test.ts ← 5 unit tests
```

---

## API Reference

### `createCloudSandbox(config: CloudSandboxConfig): Result<SandboxAdapter, KoiError>`

Dispatch factory. Routes to the correct provider factory based on `config.provider`.

Returns `Result<SandboxAdapter, KoiError>`:
- `{ ok: true, value: SandboxAdapter }` on success
- `{ ok: false, error: KoiError }` with code `"VALIDATION"` for unknown providers, or any provider-specific validation error

### Types

```typescript
/** Discriminated union — provider field selects the variant. */
type CloudSandboxConfig =
  | { readonly provider: "cloudflare" } & CloudflareAdapterConfig
  | { readonly provider: "daytona" } & DaytonaAdapterConfig
  | { readonly provider: "e2b" } & E2bAdapterConfig
  | { readonly provider: "vercel" } & VercelAdapterConfig;

/** String literal union of supported providers. */
type CloudSandboxProvider = "cloudflare" | "daytona" | "e2b" | "vercel";
```

### Re-Exported Provider Factories

| Factory | Source Package |
|---------|---------------|
| `createCloudflareAdapter` | `@koi/sandbox-cloudflare` |
| `createDaytonaAdapter` | `@koi/sandbox-daytona` |
| `createE2bAdapter` | `@koi/sandbox-e2b` |
| `createVercelAdapter` | `@koi/sandbox-vercel` |

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

---

## Examples

### Select provider from config

```typescript
import { createCloudSandbox } from "@koi/sandbox-cloud";

const result = createCloudSandbox({
  provider: "e2b",
  client: e2bSdk,
  // ... E2B-specific fields
});

if (result.ok) {
  const adapter = result.value; // SandboxAdapter — ready for sandbox-stack
}
```

### Direct provider access (bypassing dispatch)

```typescript
import { createCloudflareAdapter } from "@koi/sandbox-cloud";

const result = createCloudflareAdapter({
  client: cfClient,
  apiToken: "...",
});
```

### With sandbox-stack

```typescript
import { createCloudSandbox } from "@koi/sandbox-cloud";
import { createSandboxStack } from "@koi/sandbox-stack";

const adapterResult = createCloudSandbox({
  provider: "vercel",
  client: vercelSdk,
});

if (adapterResult.ok) {
  const stack = createSandboxStack({
    adapter: adapterResult.value,
    resources: { timeoutMs: 30_000 },
  });

  await stack.warmup();
  const execResult = await stack.executor.execute("console.log('hi')", null, 5000);
  await stack.dispose();
}
```

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Static imports (not dynamic) | All 4 cloud providers are lightweight stubs — SDKs are injected via `client` field. No cold-start penalty from importing unused providers |
| Discriminated union with `provider` field | Manifest-friendly — string-based selection. TypeScript exhaustiveness checking catches missing providers |
| Separate from `sandbox-stack` | `sandbox-stack` is adapter-agnostic (DI pattern). This package knows about specific cloud providers. Different responsibilities |
| Re-exports cloud-base utilities | One import for everything cloud-sandbox-related. Consumers don't need to know about `@koi/sandbox-cloud-base` |
| `VALIDATION` error for unknown provider | Consistent with L0 `KoiErrorCode`. Unknown provider is input validation, not an internal error |

---

## Testing

```
create-cloud-sandbox.test.ts — 5 tests
  ● dispatches to createCloudflareAdapter for provider cloudflare
  ● dispatches to createDaytonaAdapter for provider daytona
  ● dispatches to createE2bAdapter for provider e2b
  ● dispatches to createVercelAdapter for provider vercel
  ● returns validation error for unknown provider
```

```bash
bun --cwd packages/meta/sandbox-cloud test
# 5 pass, 0 fail
```

---

## Layer Compliance

```
L0  @koi/core ──────────────────────────────────────┐
    SandboxAdapter, KoiError, Result                 │
                                                      │
L0u @koi/sandbox-cloud-base ────────────┐            │
    createCachedBridge, classifyCloud-   │            │
    Error, createCloudInstance           │            │
                                         │            │
L2  @koi/sandbox-{cloudflare,daytona,   │            │
    e2b,vercel} ─────────────────────────┤            │
                                         ▼            ▼
L3  @koi/sandbox-cloud ◄──────────────────────────────┘
    ✓ imports from L0 + L0u + L2 only (valid for L3)
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L3 packages
    ✓ All interface properties readonly
    ✓ import type for type-only imports
    ✓ .js extensions on all local imports
    ✓ No enum, any, namespace, as Type, !
    ✓ Exhaustive switch with never check
```
