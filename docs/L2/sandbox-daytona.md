# @koi/sandbox-daytona — Daytona hosted-cloud SandboxAdapter

L2 package. Wraps Daytona's managed-workspace API as a Koi `SandboxAdapter`, producing `SandboxInstance` handles backed by remote workspaces.

---

## What This Feature Enables

A `SandboxAdapter` whose `create(profile)` returns a `SandboxInstance` running inside a Daytona workspace. Surface:

- `exec(command, args, options)` — run a command. `AbortSignal` is forwarded into the SDK and raced locally so callers always see prompt cancellation (`exitCode = 130`).
- `readFile(path)` / `writeFile(path, content)` — workspace file I/O. Prefers binary-safe `readBytes` / `writeBytes` when the SDK exposes them; otherwise rejects non-UTF-8 writes fail-closed.
- `destroy()` — permanently delete the remote workspace. **Requires** `sdk.delete()`. Some Daytona SDK versions implement `close()` as a client-side detach that leaves the workspace running and billable, so the adapter refuses to fall back to `close()` — falling back would mark the instance destroyed locally while the remote workspace silently keeps running. Callers must inject a `delete`-capable SDK wrapper. Idempotent on success, retryable on transient SDK failure, concurrent calls coalesce.

The adapter accepts a pluggable `client` so tests run with no network and so production callers control how `@daytonaio/sdk` (or any other client) is wired in.

---

## Why It Exists

Daytona offers fast-provisioning workspaces with native FUSE mounts and per-region targeting. Like `@koi/sandbox-e2b`, this adapter is a thin shim that turns Daytona's surface into Koi's `SandboxAdapter` contract — keeping backend swaps trivial.

---

## Architecture

```
@koi/sandbox-daytona (L2)
├── adapter.ts   — createDaytonaAdapter(config): Result<SandboxAdapter, KoiError>
├── instance.ts  — createDaytonaInstance(sdk): SandboxInstance
├── types.ts     — DaytonaAdapterConfig, DaytonaClient, DaytonaSdkSandbox
├── validate.ts  — validateDaytonaConfig: env fallback (KEY + URL) + client requirement
└── index.ts     — public API surface

Dependencies
- @koi/core (L0) — SandboxAdapter, SandboxInstance, SandboxProfile, KoiError, Result
```

The `@daytonaio/sdk` is **not** a static dependency. Callers inject a `DaytonaClient` wrapper at assembly time.

---

## Public API

### `createDaytonaAdapter(config: DaytonaAdapterConfig): Result<SandboxAdapter, KoiError>`

Validates config and returns the adapter. Returns `{ ok: false, error: { code: "VALIDATION", ... } }` when the API key is missing (and no `DAYTONA_API_KEY` env var is set) or when `client` is omitted.

`DaytonaAdapterConfig` fields:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `apiKey` | `string` | `process.env.DAYTONA_API_KEY` | Daytona API key |
| `apiUrl` | `string` | `process.env.DAYTONA_API_URL` | Custom API endpoint |
| `target` | `string` | `"us"` | Region target |
| `client` | `DaytonaClient` | (required) | Injected SDK wrapper |

### `createDaytonaInstance(sdk: DaytonaSdkSandbox): SandboxInstance`

Low-level helper for callers that already hold a workspace handle.

---

## Profile Mapping (fail-closed)

The hosted backend has no provider-side hook for filesystem allow/deny lists, network deny, Nexus FUSE mounts, or process/memory caps yet (those land with `@koi/sandbox-cloud-base` — issue #1379). Until then `create(profile)` **rejects** profiles that ask for any of those fields:

| Profile request | Behaviour |
|-----------------|-----------|
| `network.allow=false` | `create()` throws — refuses to provision |
| `filesystem.defaultReadAccess="closed"` | `create()` throws |
| `filesystem.allow{Read,Write}` / `deny{Read,Write}` | `create()` throws |
| `nexusMounts` (non-empty) | `create()` throws |
| `resources.maxMemoryMb` / `maxPids` / `maxOpenFiles` | `create()` throws |
| `env` | forwarded as default per-call `envs` (per-call `env` wins) |
| `resources.timeoutMs` | forwarded as default per-call `timeoutMs` (per-call wins) |

## Per-call exec capability gating

`SandboxExecOptions.stdin`, `maxOutputBytes`, and `signal` each gate on a matching SDK capability flag (`commands.supportsStdin` / `supportsMaxOutputBytes` / `supportsAbort`). Without the flag, callers that supply the corresponding field see a fail-closed error.

There is **no implicit default output cap**. The adapter only enforces a cap when both (a) the caller passes `maxOutputBytes` AND (b) the injected SDK advertises `commands.supportsMaxOutputBytes=true`; otherwise it would be claiming a memory bound it cannot deliver post-buffer. When both hold, the cap is forwarded server-side and applied as a **single byte budget across stdout + stderr** with byte-accurate UTF-8 truncation; `truncated=true` is set when any byte is dropped.

`readFile` requires `sdk.files.readBytes` for binary-safe reads. `writeFile` rejects non-UTF-8 bytes when the SDK is text-only.

---

## Tests

```
src/validate.test.ts   — config validation, env fallback, target default
src/instance.test.ts   — exec/readFile/writeFile/destroy delegation
src/adapter.test.ts    — adapter factory, create() → instance
```

Tests use a hand-rolled `FakeDaytonaClient` — no network, no real `@daytonaio/sdk` import.

---

## Layer Compliance

```
L0  @koi/core ────────────────────────────────────────┐
    SandboxAdapter, SandboxInstance, SandboxProfile,   │
    KoiError, Result                                   │
                                                       │
L2  @koi/sandbox-daytona ◄─────────────────────────────
    only imports @koi/core
    optional package — assembled at runtime
```
