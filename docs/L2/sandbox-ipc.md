# @koi/sandbox-ipc — Structured host-worker bridge

L2 package that runs untrusted code in a Bun child and moves requests/results
over a typed IPC protocol instead of stderr framing or backend-specific glue.

## Layer

```
L2  @koi/sandbox-ipc
    depends on: @koi/core (L0), @koi/sandbox-cloud-base (L0u)
    does NOT import: peer sandbox packages or engine/meta-stack layers
```

## Purpose

`@koi/sandbox-ipc` owns the structured host-worker bridge for code execution.
It exposes low-level bridge primitives for sandbox backends that want direct
control, while also adapting that bridge back into the existing
`SandboxExecutor` contract for current consumers.

## Public surface

- `createSandboxBridge(config)` builds the typed Bun-child bridge
- protocol, error, and bridge result types stay available to backend authors
- `bridgeToExecutor(config)` is the compatibility surface for
  `SandboxExecutor` consumers

## Layer cleanliness

The package does not know how to wrap Bun with Docker, SSH, Seatbelt, Bubblewrap,
or any other backend-specific launcher. Instead it accepts an injected command
builder, which keeps `@koi/sandbox-ipc` layer-clean and reusable across multiple
sandbox implementations.

## Notes

- bridge errors are translated into `SandboxError` codes at the adapter edge
- `bridgeToExecutor()` reuses `createSandboxBridge()` rather than forking a
  second execution path

## Contract scope and limitations

`bridgeToExecutor()` is **not** a drop-in replacement for the existing
`@koi/sandbox-executor` subprocess executor. It deliberately narrows the
contract:

- **Code shape.** The adapter wraps `code` as a function body and runs it via
  `new Function("input", code)` inside the worker. Module source with
  `export default ...` is therefore not supported here. Migration of callers
  that pass module source must rewrite the source into a function-body shape
  (or use the existing subprocess executor) before pointing at this adapter.
- **ExecutionContext fields.** The bridge enforces `BridgeConfig.profile` as
  the upper bound on filesystem and network permissions. Per-call context can
  only narrow it (`networkAllowed: false`, tighter `resourceLimits`). The
  bridge does not append `workspacePath`/`entryPath` into the profile and the
  current `SandboxCommand` carries no `cwd`/`env`, so callers that depend on
  workspace-rooted execution or per-call environment variables must encode
  those concerns in `BridgeConfig.profile` and `BridgeConfig.buildCommand`.
- **Result size cap.** `BridgeExecOptions.maxResultBytes` is enforced by both
  the worker (pre-send) and the host (post-parse). The worker check fails fast
  with a `RESULT_TOO_LARGE`-style error frame; the host check is the
  authoritative final gate.

Parity work for the wider executor surface (module source, full
`ExecutionContext` plumbing through `SandboxCommand`) is tracked separately;
this package intentionally ships the narrower bridge first.

## Trust boundary

The host generates a per-call random nonce, sends it inside the `execute`
frame, and rejects worker terminal frames whose nonce does not match. The
worker captures the nonce, then seals its IPC channel
(`process.send`/`process.disconnect` overridden, `message` listeners removed)
before invoking untrusted code. Sealing-plus-nonce makes it infeasible for
worker payloads to forge a `result`/`error` frame on the host channel.

The default spawn path also scrubs the worker environment to a small
allowlist (`PATH`, `HOME`, `USER`, `TMPDIR`, `LANG`, `LC_ALL`) and merges
`profile.env` (after context narrowing) on top, so ambient host secrets do
not flow into untrusted code by default. Override the allowlist with
`BridgeConfig.envAllowlist` if a backend has additional safe variables.

### Process-group isolation (descendant teardown)

`BridgeConfig.processGroupIsolation` controls how the default spawn
implementation handles descendants the worker may itself spawn.

- `"best-effort"` (default): if `setsid` is on `PATH`, the worker is launched
  inside its own session and the bridge kills the entire group on
  timeout/dispose. If `setsid` is missing (default macOS without
  util-linux), only the direct worker is killed — descendants may survive.
- `"required"`: refuse to spawn unless `setsid` is available. Use this on
  production hosts where descendant teardown is part of the security
  contract.

Backends that ship their own spawn wrapper (`createSandboxBridge` accepts
an injected `spawnFn`) can implement equivalent isolation directly.
