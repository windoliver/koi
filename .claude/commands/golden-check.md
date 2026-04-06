---
name: golden-check
description: Check if the current branch's PR needs golden queries and trajectories, record missing ones, and validate until correct.
allowed-tools: Bash Read Write Edit Glob Grep Agent
---

# Golden Query & Trajectory Checker

You are auditing the **current branch** for missing golden query and trajectory coverage per the project rule: **every new L2 package must be wired into `@koi/runtime` with golden query coverage.**

## Step 1: Identify new/modified L2 packages on this branch

1. Determine the merge base: `git merge-base HEAD main`
2. Get all files changed on this branch: `git diff --name-only <merge-base>...HEAD`
3. From the changed files, identify which `packages/*/` directories were touched. For each, read its `package.json` to get the `@koi/*` package name.
4. Classify each package. A package is **L2** if it is NOT in:
   - L0: `@koi/core`
   - L0u: listed in `scripts/layers.ts` as `L0U_PACKAGES`
   - L1: `@koi/engine`, `@koi/engine-compose`, `@koi/engine-reconcile`
   - L3: `@koi/cli`, `@koi/runtime`
5. For each L2 package found, check:
   - Is it wired as a dependency in `packages/meta/runtime/package.json`?
   - Does it have golden query assertions in `packages/meta/runtime/src/__tests__/golden-replay.test.ts`? (grep for `Golden: @koi/<name>` or the package name)
   - Does it have fixture files in `packages/meta/runtime/fixtures/` (`.cassette.json` and/or `.trajectory.json`)?

## Step 2: Report findings

Present a table:

| Package | Wired to runtime? | Golden queries? | Trajectory fixture? | Status |
|---------|-------------------|-----------------|---------------------|--------|

Packages that don't expose tools or middleware (e.g. `@koi/tui` -- pure UI rendering) can be marked N/A with explanation.

If everything is covered, report "All clear" and stop.

## Step 3: Fix missing coverage (if gaps found)

For each L2 package missing coverage, do ALL of the following:

### 3a. Wire into `@koi/runtime`

Add the package as a dependency in `packages/meta/runtime/package.json` and `packages/meta/runtime/tsconfig.json` if not already present.

### 3b. Add golden query config to recording script

Edit `packages/meta/runtime/scripts/record-cassettes.ts`:
1. Add necessary imports for the new package
2. Add a `QueryConfig` entry to the `queries` array with:
   - A descriptive `name` (kebab-case, e.g. `"task-tools-create"`)
   - A `prompt` that exercises the package's primary tools/features
   - Appropriate `permissionMode`, `permissionRules`, `hooks`, `providers`
   - `maxTurns` if tool calls are expected (typically 2-3)
3. If the package provides tools, add a cassette recording call (like `recordCassette(...)`)
4. Study existing query configs for the pattern -- match the style

### 3c. Record trajectories

Run the recording script:
```bash
OPENROUTER_API_KEY="$OPENROUTER_API_KEY" bun run packages/meta/runtime/scripts/record-cassettes.ts
```

If recording fails, diagnose and fix the issue (missing imports, wrong tool names, etc.) and re-record.

### 3d. Add golden query assertions to test file

Edit `packages/meta/runtime/src/__tests__/golden-replay.test.ts`:
1. Add a `describe("Golden: @koi/<package-name>", ...)` section with at least 2 standalone tests
2. Tests should validate the package's core behavior WITHOUT requiring an LLM:
   - Import the package's public API directly
   - Test tool creation, provider setup, core logic
   - Validate types, schemas, and behavior
3. If a cassette was recorded, add a cassette replay test that validates the ATIF trajectory

Study existing golden query sections for the exact pattern.

### 3e. Validate recorded trajectories

After recording, validate the trajectory files:

1. Read each new `fixtures/<name>.trajectory.json`
2. Verify:
   - `schema_version` is `"ATIF-v1.6"`
   - `steps` array is non-empty
   - Steps have correct `source` values (`"agent"`, `"tool"`, `"system"`)
   - Tool calls (if expected) appear in the steps with correct tool names
   - No error steps unless the query is designed to test errors
3. Run the test suite to verify assertions pass:
   ```bash
   bun test --filter=@koi/runtime packages/meta/runtime/src/__tests__/golden-replay.test.ts
   ```
4. Adversarially review the trajectory by invoking `/codex:adversarial-review` with the trajectory file path as focus (e.g. `packages/meta/runtime/fixtures/<name>.trajectory.json`). Apply any critical/high-confidence findings before moving on.

### 3f. Fix until green

If tests fail:
1. Read the error output carefully
2. Fix the test assertions OR the recording config (not both blindly)
3. If the trajectory is malformed, fix the recording script and re-record
4. If assertions are wrong, fix the assertions to match the actual (correct) trajectory
5. Re-run tests until all pass
6. Also run:
   ```bash
   bun run check:orphans
   bun run check:golden-queries
   bun run typecheck
   ```

## Step 4: Final validation

Run the full CI gate for the runtime package:
```bash
bun test --filter=@koi/runtime && bun run check:orphans && bun run check:golden-queries
```

Report the final status.
