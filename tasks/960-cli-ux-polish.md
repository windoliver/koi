# Issue #960: CLI UX Polish — Colors, Spinners, Interactive Recovery

## Decisions Log

| # | Area | Decision | Choice |
|---|------|----------|--------|
| 1 | Arch | CLI render utilities location | **1A**: New `@koi/cli-render` L0u package |
| 2 | Arch | Nested streaming architecture | **2A**: Extend EngineEvent (PR 2) |
| 3 | Arch | `up.ts` decomposition | **3A**: Phase modules + `UpContext` type |
| 4 | Arch | Interactive recovery scope | **4A**: Preflight-scoped + doctor hint |
| 5 | Code | up.ts/start.ts dedup (209 LOC) | **5A**: Extract 4 shared modules |
| 6 | Code | Output abstraction | **6A**: `CliOutput` interface in cli-render |
| 7 | Code | Doctor hints placement | **7B**: CLI error handling layer |
| 8 | Code | Timer sharing | **8A**: Move to cli-render |
| 9 | Test | renderEvent() tests | **9A**: Dedicated unit tests |
| 10 | Test | up.ts phase tests | **10A**: Test each phase + orchestrator |
| 11 | Test | cli-render tests | **11A**: Full suite |
| 12 | Test | Nested streaming tests | **12C+A**: Follow-up PR |
| 13 | Perf | Color detection | **13A**: Once at module load |
| 14 | Perf | Spinner cleanup | **14A+C**: Exit handlers + no cursor hide |
| 15 | Perf | Phase imports | **15A**: Static |
| 16 | Perf | Message guard | **16A**: Keep boolean |

## PR Scope

**PR 1 (this branch):** Items 1, 3, 4, 5 — colors/spinners, `up.ts` refactor, interactive preflight recovery, doctor hints
**PR 2 (follow-up):** Item 2 — nested stream composition (L0 type changes + L1 engine + rendering)

---

## Phase 1: Create `@koi/cli-render` L0u package

### Tests first (TDD)
- [ ] `detect.test.ts` — table-driven env var combinations:
  - NO_COLOR="" → colors ON
  - NO_COLOR="1" → colors OFF
  - FORCE_COLOR=0 → OFF (overrides everything)
  - FORCE_COLOR=3 → truecolor
  - FORCE_COLOR=1 + NO_COLOR=1 → ON (FORCE_COLOR wins)
  - process.stdout.isTTY === undefined → OFF
  - process.stdout.isTTY === true, no env vars → ansi-16
  - COLORTERM=truecolor → ansi-16m
  - TERM=xterm-256color → ansi-256
- [ ] `colors.test.ts` — wrap functions return ANSI when enabled, plain when disabled
- [ ] `spinner.test.ts`:
  - Non-TTY: writes static line, no animation
  - TTY: writes frames to stream
  - stop() clears line and writes final text
  - start() after stop() works (reusable)
  - Process exit handler registered on start
  - Process exit handler cleaned up on stop
- [ ] `output.test.ts`:
  - info/warn/error/success/hint/debug write to correct stream
  - Prefixes applied: "warn:", "error:", etc.
  - Colors applied when enabled, plain when disabled
  - Spinner coordination: active spinner cleared before log line
- [ ] `timer.test.ts`:
  - enabled=false → no-op (fn still called, no entries)
  - enabled=true → records label + durationMs
  - print() outputs all entries with padding

### Implementation
- [ ] Create `packages/lib/cli-render/package.json` (deps: `@koi/core` only)
- [ ] Create `packages/lib/cli-render/tsconfig.json`
- [ ] Create `packages/lib/cli-render/tsup.config.ts`
- [ ] `src/detect.ts` — `detectColorLevel()`, `detectStreamCapabilities()`, `detectTerminal()`
- [ ] `src/colors.ts` — ANSI wrap functions: red, green, yellow, blue, cyan, gray, bold, dim
- [ ] `src/spinner.ts` — `createSpinner()` with exit cleanup, no cursor hide
- [ ] `src/output.ts` — `createCliOutput()` factory returning `CliOutput` interface
- [ ] `src/timer.ts` — extracted `createTimer()`
- [ ] `src/index.ts` — public exports
- [ ] Update `scripts/layers.ts` to register `@koi/cli-render` as L0u

### Verify
- [ ] `bun test packages/lib/cli-render/`
- [ ] `bun scripts/check-layers.ts` — no violations

---

## Phase 2: Extract shared CLI modules

### Tests first
- [ ] `render-event.test.ts` — 18-22 test cases:
  - text_delta → writes to stdout
  - tool_call_start verbose → writes [tool] prefix to stderr
  - tool_call_start non-verbose → no output
  - tool_call_end verbose → writes [tool] done
  - tool_call_end non-verbose → no output
  - done verbose → writes metrics
  - done non-verbose → writes newline only
  - turn_end → no output
  - custom → no output
  - discovery:miss → no output
  - spawn_requested → no output

### Implementation
- [ ] `packages/meta/cli/src/render-event.ts` — extracted renderEvent()
- [ ] `packages/meta/cli/src/create-runtime.ts` — shared manifest → engine → middleware → createForgeConfiguredKoi()
- [ ] `packages/meta/cli/src/create-message-handler.ts` — shared channel message loop
- [ ] `packages/meta/cli/src/create-admin.ts` — shared admin panel setup
- [ ] Add `@koi/cli-render` as dependency of `@koi/cli`

### Verify
- [ ] `bun test packages/meta/cli/src/render-event.test.ts`
- [ ] Existing `start.test.ts` and `serve.test.ts` still pass

---

## Phase 3: Refactor `up.ts` into phase modules

### Tests first
- [ ] `commands/up/types.test.ts` — UpContext type validation (optional: may skip if pure types)
- [ ] `commands/up/resolve.test.ts` — manifest path resolution
- [ ] `commands/up/validate.test.ts` — manifest loading + warning handling
- [ ] `commands/up/preset.test.ts` — preset resolution from manifest metadata
- [ ] `commands/up/preflight.test.ts` — preflight checks + interactive recovery:
  - Missing API key, TTY → offers prompt
  - Missing API key, non-TTY → error + exit
  - Missing binary → error with hint
  - All checks pass → success
- [ ] `commands/up/assemble.test.ts` — engine + middleware creation
- [ ] `commands/up/banner.test.ts` — banner output format with colored symbols

### Implementation
- [ ] `commands/up/types.ts` — `UpContext` type definition
- [ ] `commands/up/resolve.ts` — (ctx) => Promise<UpContext>
- [ ] `commands/up/validate.ts`
- [ ] `commands/up/preset.ts`
- [ ] `commands/up/preflight.ts` — with @clack/prompts interactive fix-it (TTY only)
- [ ] `commands/up/nexus.ts`
- [ ] `commands/up/temporal.ts`
- [ ] `commands/up/assemble.ts`
- [ ] `commands/up/start.ts`
- [ ] `commands/up/admin.ts`
- [ ] `commands/up/banner.ts`
- [ ] `commands/up/index.ts` — orchestrator (~100-150 lines), wires CliOutput + spinner per phase
- [ ] Delete original `commands/up.ts` (903 lines)

### Verify
- [ ] `bun test packages/meta/cli/src/commands/up/`
- [ ] `bun run build` — no import errors
- [ ] Manual: `koi up` works with colors/spinners in TTY
- [ ] Manual: `koi up 2>/dev/null | cat` — no ANSI codes in piped output

---

## Phase 4: Wire colors/spinners into orchestrator

- [ ] Each phase gets spinner: "Resolving manifest...", "Running preflight checks...", etc.
- [ ] Phase completion: "✓ Manifest resolved" (green), "! Preflight warning" (yellow), "✗ Failed" (red)
- [ ] Banner uses colored output
- [ ] All disabled when `!isTTY` or `NO_COLOR`

---

## Phase 5: Update `start.ts` + doctor hints

- [ ] Replace inline renderEvent() → import from render-event.ts
- [ ] Replace inline assembly → import from create-runtime.ts
- [ ] Replace inline message handler → import from create-message-handler.ts
- [ ] Replace inline admin setup → import from create-admin.ts
- [ ] Add `--timing` flag using createTimer() from cli-render
- [ ] Add `koi doctor --repair` hint in error handling for VALIDATION/NOT_FOUND errors
- [ ] start.ts target: ~200 lines (down from 553)

### Verify
- [ ] `bun test packages/meta/cli/` — all existing tests pass
- [ ] `bun run build` — clean
- [ ] `bun scripts/check-layers.ts` — no violations

---

## Acceptance Criteria (from issue)

- [ ] `koi up` shows colored status lines (✓ green, ! yellow, ✗ red) with spinner during each phase
- [ ] Colors/spinners disabled when `!process.stdout.isTTY` or `NO_COLOR` env var set
- [ ] `up.ts` refactored to <200 lines with phases in `commands/up/*.ts`
- [ ] Preflight failures offer interactive fix when TTY detected
- [ ] Config errors include `koi doctor` hint
- [ ] (Deferred to PR 2) Child agent spawn/completion events visible in parent CLI session
