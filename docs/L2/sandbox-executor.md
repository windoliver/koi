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
}

export function createSubprocessExecutor(
  config?: SubprocessExecutorConfig,
): SandboxExecutor;
```

`executor.execute(code, input, timeoutMs, context?)`:

1. Writes `code` to a temp file under `os.tmpdir()`.
2. Spawns `bun run <runner.ts>` with the temp path + JSON-encoded `input` on argv.
3. Reads stderr until the `__KOI_RESULT__\n` marker; rest is `SubprocessOutput`.
4. SIGKILLs on timeout; classifies non-zero exits as `CRASH`/`OOM`/`PERMISSION`.
5. Returns `Result<SandboxResult, SandboxError>`.

## Output capping

Both stdout and stderr are read with a streaming byte-cap (`readBoundedText`) that
stops consuming and cancels the reader once `maxOutputBytes` is reached. When the cap
is hit, the child is killed via `killChild` so it doesn't keep producing output.
This prevents an adversarial child from OOMing the host.

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
