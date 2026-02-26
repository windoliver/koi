# @koi/code-mode

Structured code generation with two-phase propose-and-apply workflow.
Agents create reviewable plans, the system validates them against the
filesystem, and applies them atomically with rollback on failure.

**Layer:** L2 (depends on `@koi/core` + `@koi/hash` only)

## How It Works

```
  Agent                      code-mode                    Filesystem
    │                            │                            │
    │  code_plan_create          │                            │
    │  { steps: [...] }          │                            │
    │───────────────────────────▶│  read referenced files     │
    │                            │───────────────────────────▶│
    │                            │◀───────────────────────────│
    │                            │                            │
    │                            │  validate steps            │
    │                            │  compute hashes            │
    │                            │  generate preview          │
    │                            │                            │
    │  ◀── PlanPreview ──────────│                            │
    │  (diff with context lines) │                            │
    │                            │                            │
    │  code_plan_apply           │                            │
    │  { planId?: "..." }        │                            │
    │───────────────────────────▶│  check staleness (rehash)  │
    │                            │───────────────────────────▶│
    │                            │◀───────────────────────────│
    │                            │                            │
    │                            │  for each step:            │
    │                            │    snapshot ──────────────▶│
    │                            │    apply    ──────────────▶│
    │                            │                            │
    │                            │  on failure:               │
    │                            │    rollback (LIFO) ───────▶│
    │                            │                            │
    │  ◀── ApplyResult ─────────│                            │
    │  { success, rolledBack }   │                            │
```

## Step Kinds

Three operations cover the full file lifecycle:

| Kind     | Header   | Input                  | What it does                     |
|----------|----------|------------------------|----------------------------------|
| `create` | `+++`    | `path`, `content`      | Write a new file                 |
| `edit`   | `~~~`    | `path`, `edits[]`      | Search-and-replace hunks         |
| `delete` | `---`    | `path`                 | Remove an existing file          |

Each edit hunk is `{ oldText, newText }` — exact string match, replaced once.

## Tools

All three tools are attached automatically when the agent has a `FILESYSTEM`
component. Tool names use a configurable prefix (default: `code_plan`).

### code_plan_create

Propose a plan. Validates all steps, hashes files for staleness detection,
and returns a diff-style preview.

```json
{
  "steps": [
    {
      "kind": "edit",
      "path": "/src/index.ts",
      "edits": [{ "oldText": "\"1.0.0\"", "newText": "\"2.0.0\"" }],
      "description": "bump version"
    },
    {
      "kind": "create",
      "path": "/CHANGELOG.md",
      "content": "# v2.0.0\n- Bumped version"
    },
    {
      "kind": "delete",
      "path": "/src/legacy.ts",
      "description": "remove deprecated module"
    }
  ]
}
```

**Returns** a `PlanPreview`:

```
  ~~~ /src/index.ts (bump version)
    import { foo } from "./bar.js";          ← 3 context lines before

  - export const version = "1.0.0";
  + export const version = "2.0.0";

    export function main() {                 ← 3 context lines after
      return version;
    }

  +++ /CHANGELOG.md
  + # v2.0.0
  + - Bumped version

  --- /src/legacy.ts (remove deprecated module)
  (file will be deleted)
```

Preview is truncated at 50 lines per file and 200 lines total.

### code_plan_apply

Execute the pending plan. Optionally pass `planId` to confirm the right
plan is being applied.

```json
{ "planId": "01JEXAMPLE" }
```

**Execution phases:**

1. **Staleness check** — re-reads all hashed files, compares against stored
   hashes. If any file changed since plan creation, rejects with `STALE_REF`.
2. **Apply with snapshots** — for each step:
   - Snapshot current file state (content or existence)
   - Execute the operation via the filesystem backend
3. **Rollback on failure** — if any step fails, all previously applied steps
   are undone in reverse order (LIFO):

| Step kind | Rollback action                    |
|-----------|------------------------------------|
| `create`  | Delete the created file            |
| `edit`    | Restore original file content      |
| `delete`  | Recreate the file with saved content |

**Returns** an `ApplyResult`:

```json
{
  "planId": "01JEXAMPLE",
  "success": false,
  "steps": [
    { "stepIndex": 0, "path": "/src/index.ts", "success": true },
    { "stepIndex": 1, "path": "/CHANGELOG.md", "success": true },
    { "stepIndex": 2, "path": "/missing.ts", "success": false, "error": "File not found" }
  ],
  "rolledBack": true,
  "rollbackErrors": []
}
```

Rollback is best-effort. If rollback itself fails (e.g., filesystem is
down), errors are reported in `rollbackErrors` but the plan still moves
to `failed` state.

### code_plan_status

Check the current plan state. Returns `undefined` fields if no active plan.

```json
{
  "planId": "01JEXAMPLE",
  "state": "pending",
  "stepCount": 3
}
```

## Plan State Machine

```
                code_plan_create
                      │
                      ▼
                 ┌─────────┐
                 │ pending  │
                 └────┬─────┘
                      │
              code_plan_apply
                      │
               ┌──────┴──────┐
               │              │
          all succeed    any fails
               │              │
               ▼              ▼
          ┌─────────┐   ┌─────────┐
          │ applied  │   │ failed  │
          └─────────┘   └─────────┘
```

Only one plan is active per session. Creating a new plan discards the old one.

## Validation

Steps are validated at plan creation time. Errors block the plan; warnings
are attached but don't prevent creation.

| Issue kind        | Severity | When                                        |
|-------------------|----------|---------------------------------------------|
| `FILE_NOT_FOUND`  | error    | Edit or delete targets a missing file       |
| `FILE_EXISTS`     | error    | Create targets an existing file             |
| `NO_MATCH`        | error    | Edit's `oldText` not found in file          |
| `AMBIGUOUS_MATCH` | error    | `oldText` matches 2+ locations              |
| `OVERLAP`         | error    | Multiple edits overlap in the same file     |
| `FILE_TOO_LARGE`  | error    | File exceeds 5 MB                           |
| `FILE_SIZE_WARNING` | warning | File is 512 KB - 5 MB                     |
| `STALE`           | error    | File changed between create and apply       |

Staleness detection uses FNV-1a hashes computed at plan creation time and
verified at apply time.

## Integration

### With createKoi (full L1 runtime)

```typescript
import { createCodeModeProvider } from "@koi/code-mode";
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";

const runtime = await createKoi({
  manifest: {
    name: "dev-agent",
    version: "1.0.0",
    model: { name: "claude-opus-4-6" },
  },
  adapter: createLoopAdapter({ modelCall, maxTurns: 10 }),
  providers: [
    createFilesystemProvider(backend),   // provides FILESYSTEM component
    createCodeModeProvider(),            // discovers FILESYSTEM, attaches tools
  ],
});

// Agent now has code_plan_create, code_plan_apply, code_plan_status
for await (const event of runtime.run({ kind: "text", text: prompt })) {
  // process events...
}
```

The `createCodeModeProvider()` uses ECS component discovery: it looks for a
`FILESYSTEM` component on the agent entity. If none is found, it gracefully
skips — no tools are attached.

### Standalone (without engine)

```typescript
import {
  createPlanCreateTool,
  createPlanApplyTool,
  createPlanStatusTool,
  createPlanStore,
} from "@koi/code-mode";

const store = createPlanStore();

const createTool = createPlanCreateTool(backend, store, "code_plan", "verified");
const applyTool  = createPlanApplyTool(backend, store, "code_plan", "verified");
const statusTool = createPlanStatusTool(store, "code_plan", "verified");

// Use tools directly
const preview = await createTool.execute({ steps: [...] });
const result  = await applyTool.execute({});
```

### Configuration

```typescript
createCodeModeProvider({
  prefix: "code_plan",           // tool name prefix (default)
  trustTier: "verified",         // L0 TrustTier (default)
  validationConfig: {
    fileSizeWarnBytes: 512 * 1024,     // 512 KB (default)
    fileSizeRejectBytes: 5 * 1024 * 1024, // 5 MB (default)
  },
});
```

## Testing

Mock backends for unit tests:

```typescript
import { createMockBackend, createFailingBackend } from "@koi/code-mode";

// In-memory filesystem
const backend = createMockBackend({
  "/src/index.ts": 'export const version = "1.0.0";\n',
  "/src/legacy.ts": "// deprecated\n",
});

// Backend where all operations fail
const failing = createFailingBackend();
```

Run tests:

```bash
bun test                    # unit + deterministic E2E (102 tests)
E2E_TESTS=1 bun test       # includes real LLM test (requires API key)
```

## Constants

| Constant                  | Value       | Purpose                           |
|---------------------------|-------------|-----------------------------------|
| `DEFAULT_PREFIX`          | `code_plan` | Tool name prefix                  |
| `FILE_SIZE_WARN_BYTES`    | 524,288     | Soft warning threshold (512 KB)   |
| `FILE_SIZE_REJECT_BYTES`  | 5,242,880   | Hard reject threshold (5 MB)      |
| `PREVIEW_LINES_PER_FILE`  | 50          | Max preview lines per file        |
| `PREVIEW_LINES_TOTAL`     | 200         | Max preview lines across all files|
| `PREVIEW_CONTEXT_LINES`   | 3           | Context lines around each edit    |

## Architecture

```
packages/code-mode/src/
├── index.ts                  Public exports
├── types.ts                  All type definitions
├── constants.ts              Configuration constants
├── component-provider.ts     ECS ComponentProvider factory
├── plan-store.ts             Session-scoped plan storage
├── validation.ts             Step validation + staleness detection
├── preview.ts                Diff-style preview generation
├── parse-args.ts             Tool input parsing helpers
├── test-helpers.ts           Mock backends for testing
└── tools/
    ├── plan-create.ts        code_plan_create tool
    ├── plan-apply.ts         code_plan_apply tool (with rollback)
    └── plan-status.ts        code_plan_status tool
```

**Layer compliance:**
- Production code imports only `@koi/core` (L0) and `@koi/hash` (L0u)
- Test code may import `@koi/engine` (L1) and `@koi/engine-loop` via devDependencies
- No L2 cross-imports
