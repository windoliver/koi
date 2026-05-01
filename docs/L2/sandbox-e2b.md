# @koi/sandbox-e2b — E2B hosted-cloud SandboxAdapter

L2 package. Wraps the E2B Cloud Sandbox SDK as a Koi `SandboxAdapter`, producing `SandboxInstance` handles backed by remote microVMs.

---

## What This Feature Enables

A `SandboxAdapter` whose `create(profile)` returns a `SandboxInstance` running on E2B's hosted infrastructure. The instance exposes:

- `exec(command, args, options)` — run a command. `AbortSignal` is forwarded into the SDK and also raced locally so callers always see prompt cancellation (`exitCode = 130`).
- `readFile(path)` / `writeFile(path, content)` — sandbox file I/O. The adapter prefers binary-safe `readBytes` / `writeBytes` when the injected SDK exposes them; otherwise falls back to text mode and **rejects** non-UTF-8 writes (fail-closed) rather than silently corrupting bytes.
- `destroy()` — kill the remote sandbox. Idempotent on success, retryable on transient SDK failure, and concurrent calls coalesce.

The adapter accepts a pluggable `client` for unit tests (no real network) and falls back to `E2B_API_KEY` from the environment when `apiKey` is omitted.

---

## Why It Exists

`@koi/sandbox-os` covers local sandboxing, `@koi/sandbox-docker` covers containers, but neither offers ephemeral isolated microVMs across regions. E2B is the lowest-friction managed option — its API surface maps directly onto Koi's `SandboxAdapter` contract, so a thin adapter is all we need.

---

## Architecture

```
@koi/sandbox-e2b (L2)
├── adapter.ts   — createE2bAdapter(config): Result<SandboxAdapter, KoiError>
├── instance.ts  — createE2bInstance(sdk): SandboxInstance
├── types.ts     — E2bAdapterConfig, E2bClient, E2bSdkSandbox
├── validate.ts  — validateE2bConfig: env fallback + client requirement
└── index.ts     — public API surface

Dependencies
- @koi/core (L0) — SandboxAdapter, SandboxInstance, SandboxProfile, KoiError, Result
```

The package depends only on `@koi/core`. The E2B SDK is **not** a static dependency — callers inject a thin `E2bClient` adapter that wraps `@e2b/sdk` (or any compatible API). This keeps the install footprint zero and tests deterministic.

---

## Public API

### `createE2bAdapter(config: E2bAdapterConfig): Result<SandboxAdapter, KoiError>`

Validates config and returns an adapter. Returns `{ ok: false, error: { code: "VALIDATION", ... } }` when the client is missing and no `E2B_API_KEY` is in the environment.

`E2bAdapterConfig` fields:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `apiKey` | `string` | `process.env.E2B_API_KEY` | E2B API key |
| `template` | `string` | `undefined` | Custom sandbox template ID |
| `client` | `E2bClient` | (required) | Injected SDK wrapper |

### `createE2bInstance(sdk: E2bSdkSandbox): SandboxInstance`

Low-level helper exposed for adapters that already hold an SDK handle.

---

## Profile Mapping (fail-closed)

The hosted backend has no provider-side hook for filesystem allow/deny lists, network deny, Nexus FUSE mounts, or process/memory caps yet (those land with `@koi/sandbox-cloud-base` — issue #1379). Until then `create(profile)` **rejects** profiles that ask for any of those fields, rather than silently weakening isolation:

| Profile request | Behaviour |
|-----------------|-----------|
| `network.allow=false` | `create()` throws — refuses to provision |
| `filesystem.defaultReadAccess="closed"` | `create()` throws |
| `filesystem.allow{Read,Write}` / `deny{Read,Write}` | `create()` throws |
| `nexusMounts` (non-empty) | `create()` throws |
| `resources.maxMemoryMb` / `maxPids` / `maxOpenFiles` | `create()` throws |
| `env` | forwarded as default per-call `envs` (per-call `env` wins) |
| `resources.timeoutMs` | forwarded as default per-call `timeoutMs` (per-call wins) |

Errors include the unsupported field list so callers know exactly what policy was *not* applied.

## Per-call exec capability gating

`SandboxExecOptions.stdin` and `maxOutputBytes` are forwarded only when the injected SDK declares the matching capability flag (`commands.supportsStdin` / `commands.supportsMaxOutputBytes`). When the flag is absent the adapter throws — silently dropping these fields would mean commands hang waiting for stdin or emit unbounded output despite the caller's cap.

`readFile` requires `sdk.files.readBytes`. The text-only fallback would re-encode the SDK's string through `TextEncoder` and corrupt non-UTF-8 content, so we refuse rather than weaken the byte-oriented contract. `writeFile` accepts UTF-8 payloads on text-only SDKs and rejects non-UTF-8 input fail-closed.

---

## Tests

```
src/validate.test.ts   — config validation, env fallback
src/instance.test.ts   — exec/readFile/writeFile/destroy delegation
src/adapter.test.ts    — adapter factory, create() → instance
```

Tests use a hand-rolled `FakeE2bClient` — no network, no real `@e2b/sdk` import.

---

## Layer Compliance

```
L0  @koi/core ────────────────────────────────────────┐
    SandboxAdapter, SandboxInstance, SandboxProfile,   │
    KoiError, Result                                   │
                                                       │
L2  @koi/sandbox-e2b ◄─────────────────────────────────
    only imports @koi/core
    optional package — assembled at runtime
```
