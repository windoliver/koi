# Issue 1870 tmux WorkerBackend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tmux-backed daemon worker backend plus first-pass `koi bg attach` / `koi bg detach` wiring using persisted tmux session metadata.

**Architecture:** Extend the L0 background-session schema with optional tmux target fields, teach the file registry to persist them, implement a new `createTmuxBackend()` in `@koi/daemon`, then wire the CLI `bg` surface to use persisted tmux metadata for cross-process attach/detach. Keep lifecycle state changes in the existing registry bridge and keep tmux target persistence in spawn/registration paths.

**Tech Stack:** TypeScript, Bun test, tmux CLI, existing `@koi/core` / `@koi/daemon` / `packages/meta/cli` surfaces.

---

## File map

- Create: `packages/net/daemon/src/tmux-backend.ts`
- Create: `packages/net/daemon/src/__tests__/tmux-backend.test.ts`
- Modify: `packages/net/daemon/src/index.ts`
- Modify: `packages/kernel/core/src/daemon.ts`
- Modify: `packages/kernel/core/src/__tests__/daemon.test.ts`
- Modify: `packages/kernel/core/src/__tests__/api-surface.test.ts.snap`
- Modify: `packages/net/daemon/src/file-session-registry.ts`
- Modify: `packages/net/daemon/src/__tests__/file-session-registry.test.ts`
- Modify: `packages/net/daemon/src/__tests__/public-exports.test.ts`
- Modify: `packages/meta/cli/src/commands/bg.ts`
- Modify: `packages/meta/cli/src/commands/bg.test.ts`
- Modify: `packages/meta/cli/src/wire-daemon-supervisor.ts`
- Modify: `docs/L2/daemon.md`

### Task 1: Add L0 tmux session metadata to the background-session schema

**Files:**
- Modify: `packages/kernel/core/src/daemon.ts`
- Test: `packages/kernel/core/src/__tests__/daemon.test.ts`
- Test: `packages/kernel/core/src/__tests__/api-surface.test.ts.snap`

- [ ] **Step 1: Write the failing schema-validation tests**

Add tests in `packages/kernel/core/src/__tests__/daemon.test.ts` for:

```ts
it("accepts tmux metadata on tmux-backed records", () => {
  const result = validateBackgroundSessionRecord({
    ...baseRecord,
    backendKind: "tmux",
    tmuxSessionName: "alpha-daemon-workers",
    tmuxWindowTarget: "alpha-daemon-workers:workers",
    tmuxPaneId: "%12",
  });
  expect(result.ok).toBe(true);
});

it("rejects tmux metadata on non-tmux-backed records", () => {
  const result = validateBackgroundSessionRecord({
    ...baseRecord,
    backendKind: "subprocess",
    tmuxSessionName: "alpha-daemon-workers",
  });
  expect(result.ok).toBe(false);
});

it("rejects empty tmux identifiers", () => {
  const result = validateBackgroundSessionRecord({
    ...baseRecord,
    backendKind: "tmux",
    tmuxSessionName: "",
  });
  expect(result.ok).toBe(false);
});
```

- [ ] **Step 2: Run the focused core test file**

Run: `bun test packages/kernel/core/src/__tests__/daemon.test.ts`
Expected: FAIL because tmux metadata fields do not exist yet.

- [ ] **Step 3: Extend the core background-session types and validator**

Update `packages/kernel/core/src/daemon.ts` to add:

```ts
readonly tmuxSessionName?: string | undefined;
readonly tmuxWindowTarget?: string | undefined;
readonly tmuxPaneId?: string | undefined;
```

to both `BackgroundSessionRecord` and `BackgroundSessionUpdate`, and extend the validation logic so:

```ts
const hasTmuxMetadata =
  typeof record.tmuxSessionName === "string" ||
  typeof record.tmuxWindowTarget === "string" ||
  typeof record.tmuxPaneId === "string";

if (hasTmuxMetadata && record.backendKind !== "tmux") {
  return validationError("tmux metadata requires backendKind=tmux");
}
```

Also reject empty-string tmux fields individually.

- [ ] **Step 4: Update the API snapshot**

Run: `bun test packages/kernel/core/src/__tests__/api-surface.test.ts --update-snapshots`
Expected: snapshot updates to include the new optional tmux fields.

- [ ] **Step 5: Re-run core tests**

Run: `bun test packages/kernel/core/src/__tests__/daemon.test.ts packages/kernel/core/src/__tests__/api-surface.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/kernel/core/src/daemon.ts packages/kernel/core/src/__tests__/daemon.test.ts packages/kernel/core/src/__tests__/api-surface.test.ts.snap
git commit -m "feat: add tmux metadata to background session records"
```

### Task 2: Teach the file registry to persist and round-trip tmux metadata

**Files:**
- Modify: `packages/net/daemon/src/file-session-registry.ts`
- Test: `packages/net/daemon/src/__tests__/file-session-registry.test.ts`

- [ ] **Step 1: Write the failing registry round-trip tests**

Add tests in `packages/net/daemon/src/__tests__/file-session-registry.test.ts` that register and reload:

```ts
await registry.register({
  workerId: workerId("w-tmux"),
  agentId: agentId("researcher"),
  pid: 4242,
  status: "running",
  startedAt: Date.now(),
  logPath: "",
  command: ["bun", "run", "worker.ts"],
  backendKind: "tmux",
  tmuxSessionName: "alpha-daemon-workers",
  tmuxWindowTarget: "alpha-daemon-workers:workers",
  tmuxPaneId: "%9",
});
```

Then assert `get()` and `list()` preserve all three tmux fields.

- [ ] **Step 2: Run the focused registry tests**

Run: `bun test packages/net/daemon/src/__tests__/file-session-registry.test.ts`
Expected: FAIL because the registry serializer/parser does not preserve the new fields yet.

- [ ] **Step 3: Extend registry parsing and update merge logic**

Update `packages/net/daemon/src/file-session-registry.ts` so:

- JSON parsing accepts optional `tmuxSessionName`, `tmuxWindowTarget`, `tmuxPaneId`
- writes include those fields when defined
- `update()` merges them like the other optional persisted fields

Use the same backward-compatible pattern the file already uses for optional `sessionId`, `version`, and terminal metadata.

- [ ] **Step 4: Re-run the registry tests**

Run: `bun test packages/net/daemon/src/__tests__/file-session-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/net/daemon/src/file-session-registry.ts packages/net/daemon/src/__tests__/file-session-registry.test.ts
git commit -m "feat: persist tmux session metadata in file registry"
```

### Task 3: Build the tmux backend with abort-aware watch semantics

**Files:**
- Create: `packages/net/daemon/src/tmux-backend.ts`
- Test: `packages/net/daemon/src/__tests__/tmux-backend.test.ts`
- Modify: `packages/net/daemon/src/index.ts`
- Test: `packages/net/daemon/src/__tests__/public-exports.test.ts`

- [ ] **Step 1: Write the failing backend tests**

Create `packages/net/daemon/src/__tests__/tmux-backend.test.ts` with coverage for:

```ts
it("reports unavailable when tmux is missing", async () => { /* mock exec */ });
it("spawns a pane and returns backendKind=tmux", async () => { /* mock tmux calls */ });
it("terminate closes a long-running pane", async () => { /* simulate pane death */ });
it("kill is idempotent when the pane is already gone", async () => { /* simulate ESRCH-ish tmux failure */ });
it("multiple workers get distinct pane ids", async () => { /* unique pane allocation */ });
it("watch returns when AbortSignal fires mid-iteration", async () => { /* mirror subprocess abort contract */ });
```

If mocking the tmux process directly is awkward, introduce a small injectable helper inside `tmux-backend.ts`:

```ts
type RunTmux = (args: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
```

and export only `createTmuxBackend()`, not the helper.

- [ ] **Step 2: Run the new backend tests**

Run: `bun test packages/net/daemon/src/__tests__/tmux-backend.test.ts`
Expected: FAIL because the backend file does not exist yet.

- [ ] **Step 3: Implement the backend**

Create `packages/net/daemon/src/tmux-backend.ts` with:

- `createTmuxBackend()`
- worktree-based session naming from `basename(request.cwd ?? process.cwd())`
- in-memory worker state map keyed by `WorkerId`
- `isAvailable()` using `tmux -V`
- `spawn()` using `new-session` / `new-window` / `split-window`, pane-title setup, and pane-id / pane-pid capture
- buffered `started` and terminal events
- `terminate()`, `kill()`, `isAlive()`
- `watch(id, signal?)` implemented as replay + polling + abort listener cleanup

Implementation constraint:

```ts
if (signal?.aborted) return;
const onAbort = () => cancelResolve();
signal?.addEventListener("abort", onAbort, { once: true });
try {
  // poll / await
} finally {
  signal?.removeEventListener("abort", onAbort);
}
```

- [ ] **Step 4: Export and assert public surface**

Update `packages/net/daemon/src/index.ts`:

```ts
export { createTmuxBackend } from "./tmux-backend.js";
```

and extend `packages/net/daemon/src/__tests__/public-exports.test.ts` to assert the export exists.

- [ ] **Step 5: Run backend tests**

Run: `bun test packages/net/daemon/src/__tests__/tmux-backend.test.ts packages/net/daemon/src/__tests__/public-exports.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/net/daemon/src/tmux-backend.ts packages/net/daemon/src/__tests__/tmux-backend.test.ts packages/net/daemon/src/index.ts packages/net/daemon/src/__tests__/public-exports.test.ts
git commit -m "feat: add tmux worker backend"
```

### Task 4: Persist tmux metadata from daemon wiring and registration paths

**Files:**
- Modify: `packages/meta/cli/src/wire-daemon-supervisor.ts`
- Modify: `packages/meta/cli/src/daemon-bridge.ts`
- Test: `packages/meta/cli/src/wire-daemon-supervisor.test.ts`
- Test: `packages/meta/cli/src/daemon-bridge.test.ts`

- [ ] **Step 1: Identify the registration write path and write failing tests**

Add tests in `packages/meta/cli/src/wire-daemon-supervisor.test.ts` or `daemon-bridge.test.ts` that start a tmux-backed worker and assert the registered session record contains:

```ts
backendKind: "tmux",
tmuxSessionName: expect.any(String),
tmuxWindowTarget: expect.any(String),
tmuxPaneId: expect.stringMatching(/^%/)
```

- [ ] **Step 2: Run the focused CLI daemon wiring tests**

Run: `bun test packages/meta/cli/src/wire-daemon-supervisor.test.ts packages/meta/cli/src/daemon-bridge.test.ts`
Expected: FAIL because the registration path does not write tmux metadata yet.

- [ ] **Step 3: Thread tmux metadata into the registration flow**

Update the registration/spawn code so that when a worker is launched on the tmux backend, the session record written to the file registry includes the tmux fields captured from the backend spawn result or adjacent wiring.

If the current `WorkerHandle` shape is too narrow for this, add the smallest possible adjacent transport:

- either backend-specific `backendHints`
- or a registration-side metadata object derived during spawn

Do **not** overload the registry bridge with this; keep it in the spawn path.

- [ ] **Step 4: Re-run the daemon wiring tests**

Run: `bun test packages/meta/cli/src/wire-daemon-supervisor.test.ts packages/meta/cli/src/daemon-bridge.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/meta/cli/src/wire-daemon-supervisor.ts packages/meta/cli/src/daemon-bridge.ts packages/meta/cli/src/wire-daemon-supervisor.test.ts packages/meta/cli/src/daemon-bridge.test.ts
git commit -m "feat: persist tmux targets for daemon sessions"
```

### Task 5: Wire `koi bg attach` and `koi bg detach` for tmux sessions

**Files:**
- Modify: `packages/meta/cli/src/commands/bg.ts`
- Test: `packages/meta/cli/src/commands/bg.test.ts`

- [ ] **Step 1: Write the failing CLI tests**

Extend `packages/meta/cli/src/commands/bg.test.ts` with:

```ts
it("keeps subprocess attach as a log-follow fallback", async () => { /* existing behavior */ });

it("dispatches tmux attach when tmux metadata is present", async () => {
  await writeSession(dir, {
    backendKind: "tmux",
    tmuxSessionName: "alpha-daemon-workers",
    tmuxWindowTarget: "alpha-daemon-workers:workers",
    tmuxPaneId: "%7",
  });
  // mock Bun.spawn for `tmux attach-session` or `tmux switch-client`
});

it("fails clearly when tmux attach metadata is missing", async () => {
  await writeSession(dir, { backendKind: "tmux" });
});

it("detach stays informational for non-tmux backends", async () => { /* existing behavior */ });
```

- [ ] **Step 2: Run the bg command tests**

Run: `bun test packages/meta/cli/src/commands/bg.test.ts`
Expected: FAIL because attach/detach are still placeholders.

- [ ] **Step 3: Implement tmux attach**

Update `packages/meta/cli/src/commands/bg.ts` so that:

- subprocess attach still calls `runLogs(registry, id, true)`
- tmux attach requires `tmuxSessionName`
- outside tmux, run `tmux attach-session -t <session>`
- inside tmux, prefer `tmux switch-client -t <session>` and optionally `select-window` / `select-pane`
- when attach dispatch succeeds, best-effort `registry.update(workerId(id), { status: "running" })`

- [ ] **Step 4: Implement the first-pass detach contract**

Update `packages/meta/cli/src/commands/bg.ts` so that:

- non-tmux detach keeps the current informational message
- tmux detach uses the supported attach-path environment variables to identify the worker and session
- it runs `tmux detach-client`
- it best-effort updates the registry status to `"detached"`

- [ ] **Step 5: Re-run the bg command tests**

Run: `bun test packages/meta/cli/src/commands/bg.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/meta/cli/src/commands/bg.ts packages/meta/cli/src/commands/bg.test.ts
git commit -m "feat: wire tmux bg attach and detach"
```

### Task 6: Add integration coverage and docs

**Files:**
- Modify: `packages/net/daemon/src/__tests__/subprocess-supervision.integration.test.ts`
- Modify: `docs/L2/daemon.md`

- [ ] **Step 1: Add opt-in tmux integration coverage**

Add a gated test using the repo’s existing environment-gated style:

```ts
const hasTmux = process.env.RUN_E2E === "1";
test.skipIf(!hasTmux)("tmux backend spawns a worker pane and reports liveness", async () => {
  // create backend
  // spawn worker
  // assert pane exists
  // terminate and observe terminal event
});
```

Keep this out of default CI.

- [ ] **Step 2: Update the daemon docs**

Revise `docs/L2/daemon.md` so it no longer says only subprocess ships. Add:

- tmux backend availability and session naming
- attach/detach behavior for `koi bg`
- note that tmux tests are gated

- [ ] **Step 3: Run the relevant test + doc gates**

Run:

```bash
bun test packages/net/daemon/src/__tests__/subprocess-supervision.integration.test.ts
bun run test packages/meta/cli/src/commands/bg.test.ts
```

Expected: unit tests pass; tmux E2E remains skipped unless explicitly enabled.

- [ ] **Step 4: Commit**

```bash
git add packages/net/daemon/src/__tests__/subprocess-supervision.integration.test.ts docs/L2/daemon.md
git commit -m "docs: document tmux daemon backend and bg attach flow"
```

### Task 7: Full verification pass

**Files:**
- Modify: none required unless failures are found

- [ ] **Step 1: Run focused package tests**

Run:

```bash
bun test packages/kernel/core/src/__tests__/daemon.test.ts
bun test packages/net/daemon/src/__tests__/file-session-registry.test.ts
bun test packages/net/daemon/src/__tests__/tmux-backend.test.ts
bun test packages/net/daemon/src/__tests__/public-exports.test.ts
bun test packages/meta/cli/src/commands/bg.test.ts
bun test packages/meta/cli/src/wire-daemon-supervisor.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run package-level checks**

Run:

```bash
bun --filter @koi/core test
bun --filter @koi/daemon test
bun --filter @koi/meta test
```

Expected: PASS, or isolate failures unrelated to this work.

- [ ] **Step 3: Run typecheck and lint for affected packages**

Run:

```bash
bun --filter @koi/core typecheck
bun --filter @koi/daemon typecheck
bun --filter @koi/meta typecheck
bun --filter @koi/core lint
bun --filter @koi/daemon lint
bun --filter @koi/meta lint
```

Expected: PASS.

- [ ] **Step 4: Final commit if verification required follow-up fixes**

```bash
git add <affected files>
git commit -m "fix: address tmux backend verification findings"
```
