# @koi/middleware-plan-persist

File-backed persistence layer for `write_plan` (Layer 2). Saves the
model-authored plan to disk so it survives session restarts, can be
diffed in git, edited by the user in a normal editor, and re-loaded
into a new session.

## Why

`@koi/middleware-planning` (#1836) keeps the plan in process memory. A
restart, `/clear`, or session cycle drops it. For multi-session work
that's a regression: the developer either loses the plan or has to
keep prompting the model to recreate it.

This package layers a file-backed mirror on top of the in-memory plan
without changing planning's interception model. It plugs into the
public `onPlanUpdate` hook so every successful `write_plan` is
persisted as `.koi/plans/<timestamp>-<slug>.md`, and exposes two
companion tools the model can call directly:

- `plan_save` — copy the latest committed plan into a named slug
- `plan_load` — read a stored plan back into the session

**OpenCode parity** — mirrors OpenCode's `.opencode/plans/<ts>-<slug>.md`
convention so plans are reviewable in `git log .koi/plans/` and editable
without restarting the agent.

**Coexistence** — in-memory planning is the default; file-backed
persistence is opt-in. Both can be wired together:

```typescript
const persist = createPlanPersistAdapter({ baseDir: ".koi/plans" });
const plan = createPlanMiddleware({ onPlanUpdate: persist.onPlanUpdate });

await createKoi({
  middleware: [..., plan.middleware],
  providers:  [..., ...plan.providers, ...persist.providers],
});
```

## Architecture

This package is a sibling middleware/tool bundle, not a replacement
for `@koi/middleware-planning`. It exposes:

```
createPlanPersistAdapter(opts) → {
  onPlanUpdate,   // OnPlanUpdate hook for createPlanMiddleware
  providers,      // [plan_save provider, plan_load provider]
  getActivePlan,  // diagnostic accessor for the latest mirrored plan
}
```

The adapter holds its own `Map<sessionId, PlanMirror>` updated by the
`onPlanUpdate` hook. The two tools read from that mirror — they do not
reach into `@koi/middleware-planning`'s internal state.

```
write_plan tool (planning MW)
    │
    ▼
onPlanUpdate(plan, ctx)               ← persist hook
    │
    ├── append to per-session journal (.koi/plans/_active/<sessionId>.md)
    └── update in-process mirror

plan_save({ slug? })                  ← model-callable
    │
    ▼
copy mirror → .koi/plans/<ts>-<slug>.md  (atomic temp+rename)
    │
    ▼
{ path, items }

plan_load({ path })                   ← model-callable
    │
    ▼
read .koi/plans/<ts>-<slug>.md → parse markdown → { items }
   (model is then prompted to call write_plan to hydrate session state)
```

**Why two tools and a hook, not a single auto-save:** the hook captures
*every* commit so no plan is silently lost. `plan_save` lets the model
or user mark a checkpoint with a meaningful slug; `plan_load` is the
inverse. The active journal at `.koi/plans/_active/<sessionId>.md` is a
recovery cache — overwritten on each commit, never garbage-collected
implicitly.

## API

```typescript
import { createPlanPersistAdapter } from "@koi/middleware-plan-persist";

const persist = createPlanPersistAdapter({
  baseDir: ".koi/plans",          // default
  fs: customFsLike,               // optional (default: node:fs/promises)
  now: () => Date.now(),          // optional, for deterministic tests
});
```

### Options

| Field     | Type                | Default          | Description |
|-----------|---------------------|------------------|-------------|
| `baseDir` | `string`            | `.koi/plans`     | Directory (absolute or relative to `cwd`) that holds plan files. Created on first write. Must resolve under `cwd` — see "Path safety". |
| `fs`      | `PlanPersistFs`     | `node:fs/promises` | Pluggable filesystem for tests. Implements `mkdir`, `writeFile`, `readFile`, `rename`, `stat`. |
| `now`     | `() => number`      | `Date.now`       | Clock for timestamp prefixes; injected for deterministic tests. |
| `cwd`     | `string`            | `process.cwd()`  | Project root used to resolve relative `baseDir` and as the path-traversal anchor. |

### Returned bundle

| Field            | Type                                           | Description |
|------------------|------------------------------------------------|-------------|
| `onPlanUpdate`   | `OnPlanUpdate`                                 | Pass to `createPlanMiddleware({ onPlanUpdate })`. Mirrors every successful commit to disk. |
| `providers`      | `readonly ComponentProvider[]`                 | `[plan_save provider, plan_load provider]`. Wire alongside `plan.providers`. |
| `getActivePlan`  | `(sessionId: string) => readonly PlanItem[] \| undefined` | Diagnostic accessor for the in-process mirror; returns `undefined` if no commit has landed for the session. |

## Tool surface

### `koi_plan_save`

| | |
|-|-|
| **Input** | `{ slug?: string }` — optional sluggified label; defaults to a generated word slug. |
| **Output** | `{ path: string, items: PlanItem[] }` |
| **Behavior** | Copies the latest mirrored plan for the session into `<baseDir>/<YYYYMMDD-HHmmss>-<slug>.md`. Atomic write (temp file + rename). |
| **Errors** | `{ error: "no plan to save" }` if `onPlanUpdate` has never fired for the session. `{ error: "slug invalid" }` if slug fails sanitization. |

Slug rules: `[a-z0-9-]`, 1–48 chars, no leading/trailing dash, no
double-dashes. Generated slugs use a small word list to keep filenames
human-readable (e.g. `lazy-mapping-lollipop`).

Filename collisions: timestamp resolution is to the second. On
collision the writer appends `-1`, `-2`, … up to 10 attempts; further
collisions return `{ error: "filename collision" }`.

### `koi_plan_load`

| | |
|-|-|
| **Input** | `{ path: string }` — absolute or relative to `cwd`; must resolve under `baseDir`. |
| **Output** | `{ path: string, items: PlanItem[] }` |
| **Behavior** | Reads and parses the markdown plan file. The model is prompted in the tool result to call `write_plan` with the returned items to hydrate session state. |
| **Errors** | `{ error: "path outside baseDir" }`, `{ error: "file not found" }`, `{ error: "invalid plan format" }`. |

`plan_load` is intentionally a read-only operation. It does NOT call
`write_plan` itself — the planning middleware owns the canonical
in-memory state, and routing through `write_plan` keeps the
hook-then-commit invariant intact.

## File format

```markdown
---
generated: 2026-04-17T10:23:00.000Z
sessionId: <branded session id>
epoch: 1
turnIndex: 7
---
# Plan

- [ ] Audit current auth code
- [in_progress] Design new session model
- [x] Migrate existing sessions
```

Status mapping:

| `PlanStatus`    | Markdown      |
|-----------------|---------------|
| `pending`       | `- [ ]`       |
| `in_progress`   | `- [in_progress]` |
| `completed`     | `- [x]`       |

The frontmatter is YAML-ish but parsed with a fixed-key reader (no
arbitrary YAML, no eval). Unknown frontmatter keys are tolerated and
discarded. Item content is preserved verbatim except for fence
markers (` ``` ` → `'''`) and embedded line breaks (collapsed to
spaces) — same escaping middleware-planning applies before injecting
into the next prompt.

## Atomic write

Every write goes through `<path>.tmp.<pid>.<rand>` then `fs.rename` to
the final path. A crash mid-write leaves the temp file behind but
never a partial real plan file. On restart the temp file is ignored
(no recovery — the journal at `.koi/plans/_active/<sessionId>.md`
still holds the last committed state).

## Path safety

- `baseDir` is resolved against `cwd`. If the resolved path is not
  `cwd` itself or a descendant of `cwd + sep`, the adapter throws at
  construction time. This mirrors the path-traversal guard in Claude
  Code's `getPlansDirectory()` and prevents a misconfigured baseDir
  from writing outside the project root.
- `plan_load`'s `path` is resolved the same way and must land under
  `baseDir`. Symlinks are resolved with `fs.realpath` before the
  prefix check — a symlinked `.koi/plans/escape -> /etc` is rejected.
- Slugs are sanitized to `[a-z0-9-]`. Path separators, `..`, NUL bytes,
  and Unicode normalization tricks cannot smuggle into the final
  filename.

## Session isolation

The mirror is keyed by `sessionId`. A `plan_save` from session A
writes session A's plan; it cannot exfiltrate session B's plan even
when `baseDir` is shared. `onSessionEnd` is observed (via the
`OnPlanUpdate` callback's `signal`) to drop the mirror entry —
post-teardown writes whose `signal.aborted === true` are ignored, so a
hung downstream hook cannot leak a stale plan into a recycled session.

## Concurrency

`onPlanUpdate` is called serialized per session by the planning
middleware, so the mirror update is naturally single-writer per
session. The atomic temp+rename strategy makes the on-disk file
consistent under concurrent saves across sessions sharing the same
`baseDir`.

## Observability

- Every successful `plan_save` returns `metadata.persistPath`.
- Every failure returns `metadata.planPersistError: true` so
  middleware-report and event-trace classify it as a tool failure.
- `plan_load` results carry `metadata.planLoadPath` for trace
  correlation.

## Comparison with in-memory plan

| Use case                              | Memory only | + plan-persist |
|---------------------------------------|:-----------:|:--------------:|
| Single session, fast iteration        | ✓           | ✓ (overhead)   |
| Multi-session work                    | ✗           | ✓              |
| User wants to review/edit plan        | ✗           | ✓              |
| Git history of plans                  | ✗           | ✓              |
| Sub-agent isolated plan               | ✓           | ✗ (overkill)   |

## Related

- `@koi/middleware-planning` (#1836) — required runtime peer; owns the canonical in-memory plan.
- `@koi/middleware-goal` — separate concern (user-declared objective).
- `@koi/task-tools` + `@koi/tasks` — richer task-board state.
- Issue #1843 — Goal / Plan / Task ecosystem umbrella.
- OpenCode `.opencode/plans/<ts>-<slug>.md` — UX reference.
- Claude Code `src/utils/plans.ts` — slug retry, path-traversal guard,
  `plansDirectory` resolution patterns adapted here.
