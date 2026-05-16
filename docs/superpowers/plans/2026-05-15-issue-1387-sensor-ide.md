# Issue 1387 Sensor IDE Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@koi/sensor-ide`, a low-overhead IDE activity sensor for typing, diagnostics, file switching, flow, context switching, frustration, and recent activity summaries.

**Architecture:** Add a pure optional library package under `packages/lib/sensor-ide`. It accepts normalized IDE activity events via `record()`, keeps bounded rolling in-memory state, and exposes a `SignalSource.read()` for `@koi/middleware-user-model`.

**Tech Stack:** TypeScript, Bun tests, existing monorepo workspace package scripts.

---

### Task 1: Package Skeleton And Failing Acceptance Tests

**Files:**
- Create: `packages/lib/sensor-ide/package.json`
- Create: `packages/lib/sensor-ide/tsconfig.json`
- Create: `packages/lib/sensor-ide/tsup.config.ts`
- Create: `packages/lib/sensor-ide/src/ide-activity-sensor.test.ts`

- [ ] Write tests for typing speed, error rate, file-switch frequency, flow state, context switching, frustration, bounded recent events, and `SignalSource.read()`.
- [ ] Run `bun test packages/lib/sensor-ide/src/ide-activity-sensor.test.ts` and verify it fails because the implementation does not exist yet.

### Task 2: Minimal Sensor Implementation

**Files:**
- Create: `packages/lib/sensor-ide/src/ide-activity-sensor.ts`
- Create: `packages/lib/sensor-ide/src/index.ts`

- [ ] Define normalized event types and config defaults.
- [ ] Implement `record()` with timestamp validation, pruning, and max-event capping.
- [ ] Implement `snapshot()` metric derivation from the bounded retained window.
- [ ] Implement `read()` as a `UserSignal` sensor signal.
- [ ] Run the focused sensor tests and make them pass.

### Task 3: Verification

**Files:**
- Verify package files above.

- [ ] Run `bun test packages/lib/sensor-ide/src/ide-activity-sensor.test.ts`.
- [ ] Run `bun run typecheck --filter=@koi/sensor-ide` if turbo filtering is available, otherwise `cd packages/lib/sensor-ide && bun run typecheck`.
- [ ] Run `bun run build --filter=@koi/sensor-ide` if turbo filtering is available, otherwise `cd packages/lib/sensor-ide && bun run build`.

