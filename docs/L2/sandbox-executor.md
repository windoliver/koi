# @koi/sandbox-executor — Subprocess-backed SandboxExecutor

Implements the `SandboxExecutor` contract from `@koi/core` by spawning a Bun
subprocess that loads untrusted code, runs it, and returns the result through a
stderr-framed protocol. OS-level isolation (seatbelt/bwrap) is delegated to
`@koi/sandbox-os`; this package is the executor wrapper.

## Why it exists

`@koi/forge` (verifier) and `@koi/sandbox-ipc` need to run brick code in a separate
process so timeouts can SIGKILL, OOM crashes don't take down the host, and the
host heap is invisible. This package is the *minimal* subprocess executor: it
spawns Bun, frames the result, captures bounded output, and translates exit
modes into typed `SandboxError` values.

## Layer

```
L2  @koi/sandbox-executor
    depends on: @koi/core (L0)
    does NOT import: @koi/engine (L1), peer L2
```

## Public API

```typescript
export interface SubprocessExecutorConfig {
  readonly bunPath?: string;       // default: "bun"
  readonly maxOutputBytes?: number; // default: 10 MiB
  readonly cwd?: string;
  /**
   * Caller asserts that real isolation is provided externally (e.g., by composing
   * with @koi/sandbox-os, running in a container, or operating in a trusted env).
   * When false (default), the executor refuses ExecutionContext fields that would
   * require enforcement (networkAllowed=false, resourceLimits) — failing closed
   * prevents silent trust-boundary leaks.
   */
  readonly externalIsolation?: boolean;
}

export function createSubprocessExecutor(
  config?: SubprocessExecutorConfig,
): SandboxExecutor;
```

## Isolation / explicit-deny guard

`subprocess-executor` can only *signal* isolation constraints (via env vars such as
`KOI_NETWORK_ALLOWED=0`, `KOI_MAX_MEMORY_MB`, `KOI_MAX_PIDS`) — it cannot *enforce*
them without OS-level support. The guard fires only on **explicit** isolation requests:

- Passing `context: { networkAllowed: false }` without `externalIsolation: true`
  returns `{ ok: false, error: { code: "PERMISSION" } }` immediately — explicit
  network-deny cannot be enforced in plain subprocess mode.
- Same for any `context.resourceLimits` value — OS-level enforcement required.
- **Omitting** `networkAllowed` (undefined) means "caller has no isolation opinion" —
  the executor passes through. `ExecutionContext` is also used for non-isolation
  metadata (`workspacePath`, `entryPath`, `env`) and those fields never trigger the guard.
- Passing `context: {}` or `context: { workspacePath: "/tmp/x", entryPath: "..." }` is
  always allowed — no isolation opinion, no guard.

To opt in to OS-enforced isolation — for example when composing with `@koi/sandbox-os`
which wraps the process with real OS isolation — set `externalIsolation: true` in the
config. The env-var signals are then forwarded to the child process as before.

`executor.execute(code, input, timeoutMs, context?)`:

1. Writes `code` to a temp file under `os.tmpdir()`.
2. Spawns `bun run <runner.ts>` with the temp path + JSON-encoded `input` on argv.
3. Reads stderr until the `__KOI_RESULT__\n` marker; rest is `SubprocessOutput`.
4. SIGKILLs on timeout; classifies non-zero exits as `CRASH`/`OOM`/`PERMISSION`.
5. Returns `Result<SandboxResult, SandboxError>`.

## Output capping (drain-not-kill)

Both stdout and stderr are read with a streaming byte-cap (`readBoundedText`) that
stops accumulating bytes once `maxOutputBytes` is reached. When the cap is hit, the
reader **continues draining** the underlying pipe silently (discarding excess bytes)
so the child is not blocked on a full pipe buffer — which would otherwise cause a
false TIMEOUT. The child is NOT killed on cap; only the timeout timer kills the child.

This means a noisy-but-correct child that logs more than `maxOutputBytes` to stdout
is not killed; it runs to completion. If the stderr framing marker was past the cap,
the run is classified as CRASH after natural exit. This is intentional — reserving
marker space is more complex and reserved for a future improvement.

## Process-group kill

On Linux/macOS with `setsid` on PATH, the child is wrapped in a new session
(`setsid bun run ...`). Kill sends `SIGKILL` to `-proc.pid` (negative PID = whole
process group), cleaning up grandchild processes automatically.

On environments without `setsid` (Windows, minimal containers), only the direct
child is killed. Descendant cleanup is best-effort in those cases.
**TODO**: explore Bun.spawn posix\_spawn flags as a portable alternative.

## v1 references

`archive/v1/packages/virt/sandbox-executor` — ported `subprocess-runner.ts`,
trimmed `subprocess-executor.ts` (517 → ~200 LOC). Dropped inline
seatbelt/bwrap profile generation (callers now compose with `@koi/sandbox-os`).
