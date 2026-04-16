# Implementation Plan: Fix TUI orphan processes (#1750)

Spec: `docs/superpowers/specs/2026-04-15-tui-orphan-process-fix-design.md`

## Adversarial Review Findings (incorporated)

Six issues found by Codex review — all addressed below:

1. **Parent double-escalation race** — `forwardSigtermWithEscalation` has no re-entry
   guard; SIGHUP then SIGTERM would arm two SIGKILL timers. **Fix**: add module-local
   `forwardingStarted` flag.
2. **`process.stdin.resume()` risk** — could perturb OpenTUI raw input handling or Bun
   loop liveness. **Fix**: drop `resume()`, listen on `close` instead of `end` (fires
   without flowing mode), and validate which event Bun actually emits during manual test.
3. **Stdin listener leak in `finally`** — plan originally only cleaned up SIGHUP listener.
   **Fix**: named handler + `removeListener("close", onStdinClose)` in `finally`.
4. **`.on()` vs `.once()` rationale was wrong** — `.once()` is correct for a termination
   signal; re-entry is already guarded by `shutdownStarted`. **Fix**: use `.once()`.
5. **Shutdown diagnostic write on hung-up terminal** — stderr may be unwritable after PTY
   teardown. **Fix**: wrap in try/catch, best-effort only.
6. **Bun `end` vs `close` uncertainty** — which event fires on PTY teardown is
   runtime-dependent. **Fix**: listen on `close` (more reliable for fd teardown), verify
   in manual test step. If neither fires, SIGHUP + parent forwarding are the primary
   defense; stdin EOF is belt-and-suspenders.

---

## Step 1: Parent-side — add re-entry guard and SIGHUP forwarding

**File**: `packages/meta/cli/src/tui-reexec-signals.ts`

**Changes**:
- Add module-local `let forwardingStarted = false` flag
- Guard `forwardSigtermWithEscalation()` with early return if already started
- Add `process.on("SIGHUP", ...)` in `installTuiReexecSignalHandlers()` that
  calls `forwardSigtermWithEscalation(proc)` — reuses existing SIGTERM path
- Update module docstring to document SIGHUP behavior

**Why re-entry guard matters**: without it, SIGHUP → SIGTERM (or vice versa) arms
two independent SIGKILL timers and calls `proc.kill("SIGTERM")` twice. The child
handles this fine (its own `shutdownStarted` guard), but the parent would race its
own escalation timers and potentially `process.exit(143)` twice.

**Estimated diff**: +8 lines

## Step 2: Child-side — add `reason` parameter to shutdown (best-effort diagnostic)

**File**: `packages/meta/cli/src/tui-command.ts`

**Changes**:
- Add optional `reason?: string` parameter to `shutdown()` closure signature
- After the `shutdownStarted` re-entry guard, if `reason` is defined, write
  diagnostic to stderr wrapped in try/catch (PTY may already be gone):
  ```typescript
  if (reason !== undefined) {
    try { process.stderr.write(`[koi tui] shutdown: ${reason}\n`); }
    catch { /* stderr unwritable after hangup — best effort */ }
  }
  ```
- No other behavioral change — all existing callers pass no reason

**Estimated diff**: +6 lines

## Step 3: Child-side — wire SIGHUP handler

**File**: `packages/meta/cli/src/tui-command.ts`

**Changes**:
- Define `onProcessSighup` calling
  `void shutdown(129, "SIGHUP received (terminal hangup)")`
- Register with `process.once("SIGHUP", onProcessSighup)` next to SIGINT/SIGTERM
  (line ~3312). Use `.once()` — termination signal, re-entry guarded by
  `shutdownStarted`, no reason to keep listening after first delivery
- Add `process.removeListener("SIGHUP", onProcessSighup)` in `finally` block

**Estimated diff**: +6 lines

## Step 4: Child-side — wire stdin close detection

**File**: `packages/meta/cli/src/tui-command.ts`

**Changes**:
- After `result.value.start()` (line ~3315), add:
  ```typescript
  const onStdinClose = (): void => {
    void shutdown(1, "stdin closed (parent terminal gone)");
  };
  if (process.stdin.isTTY) {
    process.stdin.once("close", onStdinClose);
  }
  ```
- **No `process.stdin.resume()`** — `close` fires when the fd is destroyed,
  which doesn't require the stream to be in flowing mode. This avoids
  perturbing OpenTUI's raw terminal input handling.
- Add `process.stdin.removeListener("close", onStdinClose)` in `finally` block
  (even if not TTY — removeListener on a never-registered handler is a no-op)

**Guard**: `process.stdin.isTTY` prevents false triggers in test/pipe contexts.

**Estimated diff**: +8 lines

## Step 5: Verification

1. `bun run typecheck` — confirm no type errors
2. `bun run lint` — confirm Biome passes
3. `bun run test --filter=@koi/cli` — confirm existing tests pass
4. Manual tmux test:
   - Launch `koi tui` in a tmux session
   - `tmux kill-session`
   - **Observe**: which event fires? Check stderr for diagnostic line.
     Specifically verify whether Bun emits `close`, `end`, or neither on
     stdin when tmux destroys the PTY
   - Verify bun process exits within ~10s (`ps -ef | grep bin.ts`)
5. Verify no orphans after 3 consecutive kill cycles
6. If `close` does NOT fire under Bun: the fix still works via SIGHUP (child)
   + SIGTERM forwarding (parent). Stdin close is belt-and-suspenders. Document
   the finding in the PR description.

## Checkpoints

- [ ] After Step 1: typecheck passes, parent re-entry guard in place
- [ ] After Step 4: typecheck + lint + tests pass, all four changes complete
- [ ] After Step 5: manual verification — process exits on tmux kill, no orphans
