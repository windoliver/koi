# @koi/worktree-merge — Branch Reconciliation for Parallel Agent Work

Automated N-branch reconciliation with topological ordering, pluggable strategies, conflict resolution, verification gates, and structured result reporting. The reunification step after `@koi/workspace` isolates agents into worktrees and `@koi/orchestrator` coordinates their work.

---

## Why It Exists

When multiple agents work in parallel worktrees, each produces a branch:

```
Agent A ──► worktree-a ──► branch: feat-auth
Agent B ──► worktree-b ──► branch: feat-payments
Agent C ──► worktree-c ──► branch: feat-tests (depends on auth + payments)
```

Merging these branches back into `main` requires:

- **Dependency ordering** — `feat-tests` must merge after `feat-auth` and `feat-payments`
- **Strategy choice** — merge commit, octopus, or rebase depending on the workflow
- **Conflict handling** — two branches may modify the same file
- **Verification** — merged code must typecheck/pass tests before accepting
- **Staleness detection** — a branch may have changed since planning time
- **Atomicity** — if anything fails, restore to the pre-merge state

Without this package, the orchestrator would need to shell out to ad-hoc git commands with no structured error handling, no dependency ordering, and no rollback.

---

## Architecture

`@koi/worktree-merge` is an **L2 feature package** — depends only on L0 (`@koi/core`) and L0u (`@koi/git-utils`).

```
┌────────────────────────────────────────────────────────────┐
│  @koi/worktree-merge  (L2)                                 │
│                                                            │
│  types.ts              ← Config, outcomes, events, strategy│
│  merge-order.ts        ← Kahn's algorithm, topo levels    │
│  git-operations.ts     ← Typed wrappers around runGit     │
│  merge-sequential.ts   ← git merge --no-ff strategy       │
│  merge-octopus.ts      ← git merge N branches at once     │
│  merge-rebase-chain.ts ← git rebase + ff merge strategy   │
│  execute-merge.ts      ← Main entry point, orchestrates   │
│  index.ts              ← Public API surface                │
│                                                            │
├────────────────────────────────────────────────────────────│
│  Dependencies                                              │
│                                                            │
│  @koi/core      (L0)   Result, KoiError                   │
│  @koi/git-utils (L0u)  runGit()                            │
└────────────────────────────────────────────────────────────┘
```

---

## Where It Fits

```
┌─────────────────────────────────────────────────────────────────────┐
│  Copilot Agent — "Refactor auth across 12 files"                    │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  @koi/orchestrator  ─  Decompose into DAG, dispatch workers         │
│                                                                     │
│  ┌─────┐     ┌─────┐                                               │
│  │  A  │────>│  C  │──┐        Task DAG                             │
│  └─────┘     └─────┘  │     ┌─────┐                                │
│    │                   ├────>│  D  │                                 │
│    ▼                   │     └─────┘                                │
│  ┌─────┐               │                                            │
│  │  B  │───────────────┘                                            │
│  └─────┘                                                            │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ spawn()
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  @koi/workspace  ─  Isolate each worker into a git worktree         │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │ worktree-a/  │  │ worktree-b/  │  │ worktree-c/  │              │
│  │              │  │              │  │              │              │
│  │ ┌──────────┐ │  │ ┌──────────┐ │  │ ┌──────────┐ │              │
│  │ │code-mode │ │  │ │code-mode │ │  │ │code-mode │ │              │
│  │ │propose → │ │  │ │propose → │ │  │ │propose → │ │              │
│  │ │apply     │ │  │ │apply     │ │  │ │apply     │ │              │
│  │ └──────────┘ │  │ └──────────┘ │  │ └──────────┘ │              │
│  │ git commit   │  │ git commit   │  │ git commit   │              │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘              │
│     branch: A         branch: B         branch: C                   │
└──────────┬────────────────┬────────────────┬────────────────────────┘
           │                │                │
           └────────────────┼────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│  @koi/worktree-merge  ─  Reconcile N branches back into main        │
│                                                                     │
│  1. Topological sort by dependsOn                                   │
│  2. Group into independence levels                                  │
│  3. Merge level by level (strategy: sequential/octopus/rebase)      │
│  4. Verify after each level (typecheck, tests)                      │
│  5. Roll back to restore point on any failure                       │
│                                                                     │
│  MergeResult { outcomes: Map<branch, merged|conflict|skipped|...> } │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
                       main (unified result)
```

### Two Safety Layers

| Layer | Package | Scope | Staleness Guard | Atomicity |
|-------|---------|-------|-----------------|-----------|
| File-level | `@koi/code-mode` | Single agent, single worktree | FNV-1a hash per file | LIFO rollback of file steps |
| Branch-level | `@koi/worktree-merge` | N agents, N worktrees → 1 target | `expectedRef` SHA per branch | `git reset --hard` to restore point |

Code-mode ensures each agent's **individual changes** are safe. Worktree-merge ensures the **combined result** is correct.

---

## How It Works

### 1. Topological Sort

Branches declare dependencies. Kahn's algorithm produces an ordered sequence grouped into independence levels:

```
Input:
  core       → dependsOn: []
  api        → dependsOn: [core]
  ui         → dependsOn: [core]
  tests      → dependsOn: [api, ui]
  docs       → dependsOn: []

Output (3 levels):
  Level 0: [core, docs]        ← independent, merge first
  Level 1: [api, ui]           ← depend on core
  Level 2: [tests]             ← depends on api + ui
```

Cycles are detected and returned as a validation error with the cycle path.

### 2. Level-by-Level Merge

```
main ──────────────────────────────────────────────────►
        │                │                │
        ▼                ▼                ▼
   merge core       merge api        merge tests
   merge docs       merge ui
        │                │                │
        ▼                ▼                ▼
   verify(L0)       verify(L1)       verify(L2)
   typecheck ✓      typecheck ✓      typecheck ✓
```

If verification fails at any level, the entire merge is rolled back to the restore point captured before the first merge.

### 3. Strategy Dispatch

| Strategy | Git Commands | When to Use |
|----------|-------------|-------------|
| `sequential` | `git merge --no-ff <branch>` per branch | Default. Clean history with merge commits |
| `octopus` | `git merge <b1> <b2> <b3>` in one operation | All branches are independent, no conflicts expected |
| `rebase-chain` | `git rebase <target> <branch>` then `git merge --ff-only` | Linear history preferred (rewrites branch commits) |

Octopus falls back to sequential on conflict. Rebase-chain aborts rebase on conflict and calls the resolver.

### 4. SHA Pinning (Stale-Branch Guard)

```
Planning time:  feat-auth tip = a1b2c3d4
                                  │
                (time passes, someone pushes to feat-auth)
                                  │
Merge time:     feat-auth tip = e5f6g7h8  ← STALE!
                                  │
                executeMerge checks expectedRef
                                  │
                a1b2c3d4 ≠ e5f6g7h8 → skipped
```

Set `expectedRef` on `MergeBranch` to reject branches that changed between planning and merge execution. Optional — omitting it merges unconditionally.

---

## Configuration

```typescript
interface MergeConfig {
  readonly repoPath: string;              // Git repo path
  readonly targetBranch: string;           // Branch to merge into (e.g., "main")
  readonly branches: readonly MergeBranch[];
  readonly strategy: MergeStrategyKind;    // "sequential" | "octopus" | "rebase-chain"
  readonly verifyAfter?: VerifyAfter;      // "each" | "levels" | "all" (default: "levels")
  readonly verify?: VerifyFn;              // Optional: run typecheck/tests after merge
  readonly resolveConflict?: ConflictResolverFn;  // Optional: default aborts on conflict
  readonly signal?: AbortSignal;           // Optional: cancel mid-merge
  readonly onEvent?: (event: MergeEvent) => void; // Optional: progress notifications
}
```

### MergeBranch

```typescript
interface MergeBranch {
  readonly name: string;                   // Branch name (e.g., "feat-auth")
  readonly dependsOn: readonly string[];   // Branch names this depends on
  readonly expectedRef?: string;           // SHA pin — skip if branch tip differs
  readonly metadata?: Readonly<Record<string, unknown>>;
}
```

### ConflictResolverFn

Called when a merge produces conflicts. The default resolver aborts (fail-fast):

```typescript
type ConflictResolverFn = (conflict: ConflictInfo) => Promise<ConflictResolution>;

interface ConflictInfo {
  readonly branch: string;
  readonly conflictFiles: readonly string[];
  readonly targetRef: string;
  readonly branchRef: string;
}

type ConflictResolution =
  | { readonly kind: "resolved"; readonly commitSha: string }
  | { readonly kind: "abort" };
```

### VerifyFn

Called after merges (timing controlled by `verifyAfter`). Return `{ passed: false }` to trigger rollback:

```typescript
type VerifyFn = (
  mergedRef: string,
  mergedBranches: readonly string[],
) => Promise<VerifyResult>;
```

---

## Verification Modes

| Mode | Behavior | Use Case |
|------|----------|----------|
| `"each"` | Verify after every single branch merge | Maximum safety, catches issues early |
| `"levels"` | Verify after all branches in a level complete | Balanced — default |
| `"all"` | Single verify after all branches merged | Fastest, least safe |

```
verifyAfter: "each"       verifyAfter: "levels"      verifyAfter: "all"

merge A → verify          merge A                     merge A
merge B → verify          merge B                     merge B
merge C → verify          verify (level 0)            merge C
                          merge C                     merge D
                          verify (level 1)            merge E
                          merge D                     verify (once)
                          merge E
                          verify (level 2)
```

---

## Outcomes

Every branch gets a `BranchMergeOutcome` — a discriminated union with 5 kinds:

| Kind | Meaning | Fields |
|------|---------|--------|
| `merged` | Successfully merged | `commitSha` |
| `conflict` | Merge conflict detected | `conflictFiles`, `resolved` |
| `skipped` | Branch skipped (stale, or dep failed) | `reason` |
| `failed` | Git operation failed | `error: KoiError` |
| `reverted` | Merged then rolled back (verify failed) | `reason` |

---

## Events

Progress notifications via `onEvent` callback — 12 kinds:

| Event | Payload | When |
|-------|---------|------|
| `level:started` | `{ level, branches }` | Beginning a topo level |
| `level:completed` | `{ level }` | All branches in level merged |
| `merge:started` | `{ branch, index, total }` | About to merge a branch |
| `merge:completed` | `{ branch, commitSha }` | Branch merged successfully |
| `merge:conflict` | `{ branch, files }` | Conflict detected |
| `merge:skipped` | `{ branch, reason }` | Branch skipped (stale/dep) |
| `merge:failed` | `{ branch, error }` | Git operation failed |
| `merge:reverted` | `{ branch, reason }` | Merged then rolled back |
| `verify:started` | `{ branches }` | Running verify function |
| `verify:passed` | — | Verify succeeded |
| `verify:failed` | `{ message }` | Verify failed (triggers rollback) |
| `aborted` | `{ restoreRef }` | AbortSignal fired, restored |

---

## Usage

### Basic: Sequential merge with verification

```typescript
import { executeMerge } from "@koi/worktree-merge";

const result = await executeMerge({
  repoPath: "/path/to/repo",
  targetBranch: "main",
  strategy: "sequential",
  branches: [
    { name: "feat-auth", dependsOn: [] },
    { name: "feat-payments", dependsOn: [] },
    { name: "feat-tests", dependsOn: ["feat-auth", "feat-payments"] },
  ],
  verify: async (mergedRef, branches) => {
    const { runGit } = await import("@koi/git-utils");
    const result = await runGit(["run", "typecheck"], "/path/to/repo");
    return { passed: result.ok, message: result.ok ? undefined : result.error.message };
  },
  onEvent: (event) => console.log(`[merge] ${event.kind}`, event),
});

if (result.ok) {
  console.log(`Strategy: ${result.value.strategy}`);
  console.log(`Verified: ${result.value.verified}`);
  console.log(`Duration: ${result.value.durationMs}ms`);
  for (const [branch, outcome] of result.value.outcomes) {
    console.log(`  ${branch}: ${outcome.kind}`);
  }
}
```

### With SHA pinning

```typescript
// Capture branch SHAs at planning time
const branches = workerResults.map((w) => ({
  name: w.branchName,
  dependsOn: w.dependencies,
  expectedRef: w.commitSha,  // Captured when worker finished
}));

const result = await executeMerge({
  repoPath,
  targetBranch: "main",
  strategy: "sequential",
  branches,
});

// Check for stale branches
for (const [branch, outcome] of result.value.outcomes) {
  if (outcome.kind === "skipped") {
    console.warn(`${branch}: ${outcome.reason}`);
  }
}
```

### With AbortSignal

```typescript
const controller = new AbortController();
setTimeout(() => controller.abort(), 60_000); // 1 minute timeout

const result = await executeMerge({
  repoPath,
  targetBranch: "main",
  strategy: "octopus",
  branches: [...],
  signal: controller.signal,
});

if (result.ok && result.value.aborted) {
  console.log("Merge was cancelled — repo restored to pre-merge state");
}
```

---

## API Reference

### Entry Point

| Function | Signature | Description |
|----------|-----------|-------------|
| `executeMerge(config)` | `(MergeConfig) → Promise<Result<MergeResult, KoiError>>` | Main entry point |

### Strategy Functions

| Function | Signature | Description |
|----------|-----------|-------------|
| `mergeSequential(branch, target, repoPath, resolver)` | `→ Promise<BranchMergeOutcome>` | `git merge --no-ff` |
| `mergeOctopus(branch, target, repoPath, resolver)` | `→ Promise<BranchMergeOutcome>` | Single-branch octopus (delegates to sequential) |
| `mergeOctopusLevel(branches, target, repoPath, resolver)` | `→ Promise<ReadonlyMap<string, BranchMergeOutcome>>` | Batch octopus with sequential fallback |
| `mergeRebaseChain(branch, target, repoPath, resolver)` | `→ Promise<BranchMergeOutcome>` | Rebase onto target + ff merge |

### Ordering Functions

| Function | Signature | Description |
|----------|-----------|-------------|
| `computeMergeOrder(branches)` | `→ Result<readonly string[], KoiError>` | Kahn's topo sort |
| `computeMergeLevels(branches)` | `→ Result<readonly (readonly string[])[], KoiError>` | Group into independence levels |

### Validation

| Function | Signature | Description |
|----------|-----------|-------------|
| `validateMergeConfig(config)` | `→ Result<void, KoiError>` | Validate repoPath, targetBranch, deps |

### Types

| Type | Description |
|------|-------------|
| `MergeConfig` | Full configuration for `executeMerge()` |
| `MergeBranch` | Branch with name, dependencies, optional SHA pin |
| `MergeResult` | Aggregate result with outcomes map, timing, verified/aborted flags |
| `BranchMergeOutcome` | Per-branch outcome: merged, conflict, skipped, failed, reverted |
| `MergeEvent` | Progress notification (12 kinds) |
| `MergeStrategyKind` | `"sequential" \| "octopus" \| "rebase-chain"` |
| `MergeStrategyFn` | Shared signature for all strategy functions |
| `ConflictResolverFn` | `(ConflictInfo) → Promise<ConflictResolution>` |
| `VerifyFn` | `(mergedRef, branches) → Promise<VerifyResult>` |
| `VerifyAfter` | `"each" \| "levels" \| "all"` |

---

## Abort & Restore

Every `executeMerge` call captures a restore point (`git rev-parse HEAD`) before the first merge. The repo is restored on:

- **AbortSignal** — `signal.abort()` fires mid-merge
- **Verify failure** — verify function returns `{ passed: false }`
- **Unexpected error** — any uncaught exception during merge

```
Before merge:  HEAD = abc123 (captured as restore point)

merge A ✓
merge B ✓
merge C ✓
verify → FAILED

git reset --hard abc123  ←  restored to pre-merge state
```

---

## Layer Compliance

```
L0  @koi/core ──────────────────────────────────────────────┐
    Result, KoiError                                         │
                                                             ▼
L0u @koi/git-utils ─────────────────────────────────────────┐
    runGit()                                                 │
                                                             ▼
L2  @koi/worktree-merge <───────────────────────────────────┘
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✗ zero external dependencies
    ~ package.json: { "dependencies": { "@koi/core": "workspace:*", "@koi/git-utils": "workspace:*" } }
```
