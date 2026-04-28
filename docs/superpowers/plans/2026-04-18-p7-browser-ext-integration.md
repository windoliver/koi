# P7 — `@koi/browser-ext` Integration Implementation Plan

> **REQUIRED SUB-SKILL:** superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** Final integration step for issue #1609. Wires `@koi/browser-ext` into `@koi/runtime` (Koi's L3 bundle), adds golden-query coverage + one recorded cassette, writes the manual-E2E smoke checklist, finalizes `docs/L2/browser-ext.md`. After this plan merges, a user can run `bunx @koi/browser-ext install`, load the extension in Chrome, and use browser tools from a Koi agent.

**Architecture:** No new code of substance. This plan wires existing packages, adds tests to the runtime harness, and finishes the doc.

**Spec reference:** §11 Phase 1 step 7 (runtime wiring) + spec's "Golden Query & Trajectory Rule" from `CLAUDE.md` (required for every new L2 package PR).

**Stacking:** Depends on P1 + P2 + P3 + P4 + P5 + P6. Branch: `p7-browser-ext-integration` off P6's HEAD.

---

## File structure

Files this plan creates / modifies:

```
packages/meta/runtime/
  package.json                                    ← add @koi/browser-ext as dep
  tsconfig.json                                   ← add reference
  src/
    create-runtime.ts                             ← compose browser-ext into the default runtime assembly
    __tests__/
      golden-replay.test.ts                       ← add 2 new describe() blocks for browser-ext
  scripts/
    record-cassettes.ts                           ← add 1 new QueryConfig entry for browser-ext
  fixtures/
    browser-ext-use.cassette.json                 ← recorded cassette (checked in)
    browser-ext-use.trajectory.json               ← recorded ATIF trajectory (checked in)

packages/drivers/browser-ext/
  docs/manual-e2e.md                              ← new: end-to-end smoke checklist for reviewers
  README.md                                       ← new: quick-start

docs/L2/browser-ext.md                            ← finalize: full spec cross-references + usage examples
README.md (monorepo root)                          ← add browser-ext to the feature list
```

---

## Tasks

### Task 1: Wire `@koi/browser-ext` into `@koi/runtime`

- [ ] Add `@koi/browser-ext: workspace:*` to `packages/meta/runtime/package.json` dependencies and add the project reference to tsconfig.
- [ ] In `packages/meta/runtime/src/create-runtime.ts`, import `createExtensionBrowserDriver` and expose it as an optional provider. Existing runtime assemblies that don't configure a browser driver stay unchanged; an opt-in path exists.
- [ ] Run `bun run check:orphans` — expect `@koi/browser-ext` to no longer be flagged as orphan (previously it was a package with no downstream consumer).
- [ ] Commit: `feat(runtime): wire @koi/browser-ext as optional browser driver provider`.

### Task 2: Two standalone golden queries (no LLM)

Per spec §10.4.

Add two new `describe()` blocks to `packages/meta/runtime/src/__tests__/golden-replay.test.ts`:

1. `Golden: @koi/browser-ext attach-and-snapshot` — mocks a native host + simulated extension; creates a runtime with browser-ext driver; agent calls `browser.attach(42)` + `browser.snapshot()`. Assert ATIF trajectory contains the attach + snapshot steps; no LLM call.

2. `Golden: @koi/browser-ext ext-user-denied` — simulate `attach_ack { ok: false, reason: "user_denied" }`. Assert driver surfaces `PERMISSION` to the agent; ATIF records the denial.

- [ ] Commit: `test(runtime): add 2 standalone golden queries for browser-ext`.

### Task 3: One recorded cassette with real LLM

- [ ] Add `browser-ext-use` QueryConfig to `packages/meta/runtime/scripts/record-cassettes.ts` with a user prompt like "Navigate to example.com in my browser and summarize the page." Mock extension on the native-host side; real LLM (OpenRouter key required at record time, not test time).
- [ ] Run: `OPENROUTER_API_KEY=... bun run packages/meta/runtime/scripts/record-cassettes.ts browser-ext-use`. Commit the resulting `fixtures/browser-ext-use.cassette.json` + `fixtures/browser-ext-use.trajectory.json`.
- [ ] Add a third `describe()` block in `golden-replay.test.ts` that replays the cassette + asserts the full ATIF trajectory matches (MCP steps, MW spans, hook steps, model steps, tool steps).
- [ ] Run `bun run check:golden-queries` — expect `@koi/browser-ext` to pass (prior to this task, the package was missing golden coverage).
- [ ] Commit: `test(runtime): record browser-ext-use cassette + replay test`.

### Task 4: Manual E2E checklist

Write `packages/drivers/browser-ext/docs/manual-e2e.md` covering the step-by-step smoke for a human reviewer:

```
## Phase 1 manual E2E smoke checklist

1. `bunx @koi/browser-ext install`. Verify stdout.
2. Open chrome://extensions → Developer mode ON → Load unpacked → ~/.koi/browser-ext/extension/.
3. `bunx @koi/browser-ext status` → shows live host + matching instanceId.
4. Run `bun run packages/drivers/browser-ext/examples/smoke.ts` (Koi agent calls `browser.navigate("https://example.com")` + `browser.snapshot()`).
5. Verify: agent receives snapshot text; browser notification fired for consent; after clicking Allow once, attach succeeded.
6. Reload the extension → SW restart → agent retries; receives `REATTACH_REQUIRES_CONSENT`; user re-approves; attach succeeds.
7. `bunx @koi/browser-ext uninstall` → admin_clear_grants runs; local files removed.
8. Verify grants cleared by opening options page: no allowlist entries visible.
```

Include a short "examples/smoke.ts" file (~30 LOC) that wires up a minimal Koi runtime with browser-ext driver + runs the 2-step agent query.

- [ ] Commit: `docs(browser-ext): manual E2E smoke checklist + smoke example`.

### Task 5: README + docs polish

- [ ] Write `packages/drivers/browser-ext/README.md` — quick-start guide copy-paste-able for users; points at docs/L2/browser-ext.md for details.
- [ ] Finalize `docs/L2/browser-ext.md` — now that all tasks are complete, expand the architecture section with the actual file-layout tree; add usage examples; cross-reference all §§ of the spec; list the 7 Phase 2 items explicitly marked non-goals so reviewers don't confuse them with bugs.
- [ ] Add `@koi/browser-ext` to the monorepo-root `README.md` feature list.

- [ ] Commit: `docs(browser-ext): finalize L2 doc + README + monorepo feature list`.

### Task 6: Final gate + PR + close issue #1609

- [ ] Full monorepo gate: `typecheck && lint && check:layers && check:orphans && check:golden-queries && test && check:duplicates && check:unused`.
- [ ] Verify `bunx @koi/browser-ext install` works end-to-end on macOS (author's machine). Run the manual-E2E checklist.
- [ ] Open PR:
  - Title: `feat(browser-ext): integration + golden queries + manual E2E (P7 of #1609, closes #1609)`.
  - Body: link all prior 6 PRs; describe the 7-PR stack's final result; "Closes #1609" line.
- [ ] When merged, the issue closes automatically.

---

## Review checklist

- [ ] **Spec coverage**: §11 Phase 1 step 7 (runtime) — Task 1. Golden-query rule from CLAUDE.md — Tasks 2 + 3. Manual E2E — Task 4. Final doc polish — Task 5.
- [ ] **Deferred**: every Phase 2 item from spec §2 "Non-goals" / §11 Phase 2 list — explicitly re-noted in the finalized L2 doc.
- [ ] **Cassette**: committed to repo; binary-ish but JSONL text; ~50–200 KB range per other cassettes in `packages/meta/runtime/fixtures/`.
- [ ] **Check:orphans**: after Task 1, `@koi/browser-ext` should no longer be orphan.
- [ ] **Issue close**: PR body includes `Closes #1609` (requires the reviewer to merge with the right base; GitHub auto-closes on merge-to-main).
