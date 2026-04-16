# Design: Fix TUI orphan processes on tmux kill (#1750)

## Problem

When a tmux session running `koi tui` is killed (`tmux kill-session`), the child
Bun process survives indefinitely as an orphan (PPID 1). After many reset cycles
during a bug-bash session, 28+ orphaned processes accumulated — exhausting file
descriptors, racing on shared SQLite databases, and breaking test isolation.

**Root cause (three gaps):**

1. **No SIGHUP handler on child TUI** — tmux sends SIGHUP when the session dies;
   neither parent nor child handles it
2. **No stdin EOF detection on child TUI** — tmux closes the PTY; the child never
   monitors `process.stdin` for `end`/`close`
3. **No SIGHUP forwarding on parent wrapper** — `tui-reexec-signals.ts` forwards
   SIGTERM but not SIGHUP to the child

## Design: Defense in Depth

Fix both parent (wrapper in `bin.ts` via `tui-reexec-signals.ts`) and child
(`tui-command.ts`) so either side independently triggers clean shutdown.

### Child-side changes (`tui-command.ts`)

#### 1. SIGHUP handler

Register `process.on("SIGHUP", onProcessSighup)` alongside the existing SIGINT
and SIGTERM handlers (around line 3311). The handler calls `shutdown(129)` —
exit code 128 + 1 per POSIX convention for SIGHUP.

Use `process.on()` (not `.once()`) to match SIGINT's pattern. Although
`shutdown()` has a re-entry guard (`shutdownStarted`), using `.on()` ensures the
handler stays registered if the first delivery arrives before the listener is
fully wired.

Clean up in the existing `finally` block alongside SIGINT/SIGTERM removal.

#### 2. Stdin EOF detection

After the TUI starts (after `result.value.start()`), register a one-shot
listener on `process.stdin`:

```typescript
process.stdin.once("end", () => {
  void shutdown(1);
});
process.stdin.resume(); // ensure 'end' fires even if nothing reads stdin
```

When tmux kills the session, the PTY master side closes, delivering EOF to the
slave. `process.stdin` emits `end`. This triggers graceful shutdown.

**Guard**: only install this listener when `process.stdin.isTTY` is true — in
non-TTY contexts (piped input, tests), stdin EOF is expected and should not
trigger shutdown.

#### 3. Shutdown diagnostic logging

Add a stderr line at the top of `shutdown()` when triggered by SIGHUP or stdin
EOF, so the signal source is visible in dev logs:

```typescript
// At top of shutdown(), after the re-entry guard:
if (exitCode === 129) {
  process.stderr.write("[koi tui] shutdown: SIGHUP received (terminal hangup)\n");
} else if (exitCode === 1 && !shutdownStarted) {
  // stdin EOF path uses exitCode 1
}
```

Actually, cleaner: log the trigger reason as a parameter rather than inferring
from exit code. Add an optional `reason` string parameter to the shutdown
closure:

```typescript
const shutdown = async (exitCode = 0, reason?: string): Promise<void> => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  if (reason !== undefined) {
    process.stderr.write(`[koi tui] shutdown: ${reason}\n`);
  }
  // ... rest unchanged
};
```

Callers:
- SIGHUP: `shutdown(129, "SIGHUP received (terminal hangup)")`
- stdin EOF: `shutdown(129, "stdin closed (parent terminal gone)")` (PTY close IS a hangup)
- SIGTERM: `shutdown(143)` (no change — already well-understood)
- SIGINT/graceful: `shutdown(130)` (no change)

### Parent-side changes (`tui-reexec-signals.ts`)

#### 4. SIGHUP forwarding

Add SIGHUP handler that reuses the existing `forwardSigtermWithEscalation()`:

```typescript
export function installTuiReexecSignalHandlers(proc: Subprocess): void {
  process.on("SIGINT", noopSigintHandler);
  process.on("SIGTERM", () => {
    forwardSigtermWithEscalation(proc);
  });
  process.on("SIGHUP", () => {
    forwardSigtermWithEscalation(proc);
  });
}
```

Rationale: forward SIGHUP as SIGTERM to the child (not as SIGHUP) because:
- The child's SIGTERM handler is battle-tested and has the full cooperative
  shutdown path
- The child's new SIGHUP handler will also fire independently (defense in depth)
- `forwardSigtermWithEscalation` already has SIGKILL escalation after 10s

The parent will also receive SIGHUP directly from tmux, so it too will begin
the forward+escalation+hard-exit sequence rather than hanging on `await proc.exited`.

### Files changed

| File | Change | Lines |
|------|--------|-------|
| `packages/meta/cli/src/tui-reexec-signals.ts` | Add SIGHUP → forward as SIGTERM | ~3 lines |
| `packages/meta/cli/src/tui-command.ts` | SIGHUP handler, stdin EOF listener, shutdown reason param | ~15 lines |

**Total**: ~18 lines of production code.

### Exit code semantics

| Trigger | Exit code | Convention |
|---------|-----------|------------|
| Clean quit | 0 | Normal |
| Stdin EOF | 129 | PTY close = hangup (same as SIGHUP) |
| SIGINT (Ctrl+C) | 130 | 128 + 2 |
| SIGHUP | 129 | 128 + 1 |
| SIGTERM | 143 | 128 + 15 |

### What this does NOT change

- The existing `shutdown()` logic, hard-exit failsafe, background task teardown,
  SIGKILL escalation — all untouched
- The SIGINT double-tap state machine — untouched
- The parent's SIGINT no-op handler — untouched
- The `@koi/shutdown` L0u package — not used by TUI, stays separate

### Testing strategy

1. **Manual tmux test**: Launch TUI in tmux, `tmux kill-session`, verify process
   exits within seconds (check `ps -ef | grep bin.ts`)
2. **Unit test for SIGHUP handler registration**: Verify `process.on("SIGHUP")`
   is called during setup and removed in `finally`
3. **Unit test for stdin EOF**: Mock `process.stdin` as TTY, emit `end`, verify
   `shutdown()` is called

### Risks and mitigations

| Risk | Mitigation |
|------|------------|
| stdin EOF fires during normal input (pipe mode) | Guard: only install when `process.stdin.isTTY` |
| SIGHUP arrives during ongoing shutdown | `shutdownStarted` re-entry guard already handles |
| Double delivery (both parent SIGTERM-forward and child SIGHUP) | `shutdownStarted` guard — second call is no-op |
| `process.stdin.resume()` side effects | Stdin is already inherited and TTY-mode; resume is safe |
