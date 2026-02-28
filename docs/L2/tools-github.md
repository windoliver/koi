# @koi/tools-github — GitHub PR Lifecycle Tools

Wraps the GitHub CLI (`gh`) as 5 Koi Tool components for PR lifecycle management: create, status, review, merge, and CI wait. One factory call attaches all tools plus a `SkillComponent` with PR best-practice guidance to any agent via ECS — engines discover them with zero engine changes.

---

## Why It Exists

Agents that manage code need to interact with GitHub pull requests: check CI status, read reviews, merge when ready. Raw `gh` CLI output is unstructured, error handling is inconsistent, and there's no standard way to plug GitHub operations into the Koi middleware chain.

`@koi/tools-github` solves this by wrapping `gh` behind a typed `GhExecutor` interface, mapping CLI failures to `KoiError` codes, and exposing each operation as a Koi `Tool` component. The `ComponentProvider` pattern means any engine adapter (loop, Pi, LangGraph) discovers these tools automatically.

---

## What This Enables

### Agent-Driven PR Lifecycle

```
                      ┌──────────────────────────────────────────────┐
                      │           Your Koi Agent (YAML)              │
                      │  name: "pr-bot"                              │
                      │  model: anthropic:claude-sonnet              │
                      │  tools: [github_pr_*]                        │
                      └──────────────────┬───────────────────────────┘
                                         │
                    ┌────────────────────▼─────────────────────────┐
                    │           createKoi() — L1 Engine             │
                    │  ┌──────────────────────────────────────────┐ │
                    │  │ Middleware Chain                          │ │
                    │  │  audit → rate-limit → permissions → ...  │ │
                    │  └──────────────────────────────────────────┘ │
                    │  ┌──────────────────────────────────────────┐ │
                    │  │ Engine Adapter (Loop / Pi / LangGraph)   │ │
                    │  │  → real LLM calls (Anthropic, OpenAI)    │ │
                    │  └──────────────────────────────────────────┘ │
                    └────────────────────┬─────────────────────────┘
                                         │
              ┌──────────────────────────▼──────────────────────────────┐
              │         createGithubProvider() — THIS PACKAGE           │
              │                                                         │
              │  ONE factory → 5 Tool components + 1 Skill → ECS-attached│
              │                                                         │
              │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │
              │  │pr_create │ │pr_status │ │pr_review │ │pr_merge  │  │
              │  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘  │
              │       │            │             │             │        │
              │  ┌────▼────────────▼─────────────▼─────────────▼─────┐ │
              │  │  ci_wait                                          │ │
              │  └───────────────────────┬───────────────────────────┘ │
              │                          │                             │
              │  ┌───────────────────────▼───────────────────────────┐ │
              │  │  GhExecutor (abstraction over `gh` CLI)           │ │
              │  │  ● Spawns `gh` with structured args               │ │
              │  │  ● Returns Result<string, KoiError>               │ │
              │  │  ● Mockable for tests (inject via interface)      │ │
              │  └───────────────────────┬───────────────────────────┘ │
              └──────────────────────────┼─────────────────────────────┘
                                         │
                                         ▼
                                    GitHub CLI (`gh`)
                                         │
                                    GitHub REST API
```

### Before vs After

```
WITHOUT tools-github:  raw gh calls, ad-hoc error handling
══════════════════════════════════════════════════════════

  Agent code:
  ┌─────────────────────────────────────────────────────┐
  │ const proc = Bun.spawn(["gh", "pr", "view", ...])  │
  │ const stdout = await new Response(proc.stdout).text()│
  │ const json = JSON.parse(stdout) // may throw        │
  │ if (exitCode !== 0) { ... } // ad-hoc error parsing │
  │ // No middleware interception                        │
  │ // No trust tier enforcement                         │
  │ // No structured error codes                         │
  └─────────────────────────────────────────────────────┘


WITH tools-github:  typed tools, middleware chain, structured errors
═══════════════════════════════════════════════════════════════════

  Agent YAML:
  ┌─────────────────────────────────────────────────────┐
  │ tools: [github_pr_status, github_pr_merge, ...]     │
  │                                                     │
  │ LLM calls tools naturally:                          │
  │   "Check PR #42 status" → github_pr_status          │
  │   "Merge if approved"   → github_pr_merge           │
  │                                                     │
  │ ● Middleware intercepts every tool call              │
  │ ● Trust tiers: reads = verified, writes = promoted  │
  │ ● Structured KoiError codes (NOT_FOUND, RATE_LIMIT) │
  │ ● Errors flow back to model as tool results         │
  └─────────────────────────────────────────────────────┘
```

---

## Tool Execution Flow

### Happy Path: LLM calls `github_pr_status`

```
LLM decides: "call github_pr_status
              with { pr_number: 42 }"
        │
        ▼
  ┌────────────────┐
  │ Middleware Chain│
  │ wrapToolCall() │──── audit, rate-limit, permissions...
  └───────┬────────┘
          │
          ▼
  ┌────────────────────┐
  │ tool.execute(args)  │
  │ pr-status.ts        │
  └───────┬────────────┘
          │
    parsePrNumber(args)
    validate input ✓
          │
          ▼
  ┌────────────────────────────────────┐
  │ executor.execute(                  │
  │   ["pr", "view", "42", "--json",  │
  │    "state,isDraft,mergeable,..."]  │
  │ )                                  │
  └───────┬────────────────────────────┘
          │
     gh CLI returns JSON
          │
          ▼
  ┌────────────────────┐
  │ parseGhJson(stdout)│
  │ → structured object│
  └───────┬────────────┘
          │
          ▼
  tool_call_end event
  result: {
    state: "OPEN",
    reviewDecision: "APPROVED",
    mergeable: "MERGEABLE",
    ...
  }
          │
          ▼
  LLM receives result
  in next turn's messages[]
```

### Error Path: `RATE_LIMIT` flows back to model

```
LLM calls github_pr_status
        │
        ▼
  Middleware chain (wrapToolCall)
        │
        ▼
  executor.execute([...])
        │
  GitHub API returns 429
  gh stderr: "API rate limit exceeded"
        │
        ▼
  parseGhError(stderr, exitCode, args)
  → KoiError {
      code: "RATE_LIMIT",
      message: "API rate limit exceeded",
      retryable: true
    }
        │
        ▼
  mapErrorResult(error)
  → { code: "RATE_LIMIT", error: "API rate limit exceeded" }
        │
        ▼
  tool_call_end event
  result: { code: "RATE_LIMIT", error: "..." }
        │
        ▼
  LLM receives error in messages[]
  LLM decides: "Rate limited, I'll wait and retry"
```

### Pre-Validation: `github_pr_merge` checks before merging

```
LLM calls github_pr_merge
  { pr_number: 42, strategy: "squash" }
        │
        ▼
  validateMergeReadiness()
  ├── executor: gh pr view 42 --json state,isDraft,...
  │
  ├── isDraft? → { code: "VALIDATION", error: "PR is a draft" }
  ├── state !== "OPEN"? → { code: "VALIDATION", error: "not open" }
  ├── mergeable === "CONFLICTING"? → { code: "CONFLICT", error: "..." }
  ├── failing CI checks? → { code: "VALIDATION", error: "N failing checks" }
  │
  └── All clear ✓
        │
        ▼
  executor: gh pr merge 42 --squash
        │
        ▼
  { merged: true }
```

---

## Architecture

`@koi/tools-github` is an **L2 feature package** that depends only on `@koi/core`.

```
┌───────────────────────────────────────────────────────┐
│  @koi/tools-github  (L2)                              │
│                                                       │
│  constants.ts              ← operations, field lists  │
│  gh-executor.ts            ← GhExecutor interface     │
│  parse-args.ts             ← input validation helpers │
│  parse-gh-error.ts         ← stderr → KoiError mapper │
│  github-component-provider.ts ← ComponentProvider     │
│  test-helpers.ts           ← mock executor + helpers  │
│  index.ts                  ← public API surface       │
│                                                       │
│  tools/                                               │
│    pr-create.ts            ← github_pr_create         │
│    pr-status.ts            ← github_pr_status         │
│    pr-review.ts            ← github_pr_review         │
│    pr-merge.ts             ← github_pr_merge          │
│    ci-wait.ts              ← github_ci_wait           │
│                                                       │
├───────────────────────────────────────────────────────┤
│  External deps: NONE (gh CLI accessed via Bun.spawn)  │
│                                                       │
├───────────────────────────────────────────────────────┤
│  Internal deps                                        │
│  ● @koi/core (L0) — Tool, ComponentProvider, KoiError │
│                                                       │
│  Dev-only                                             │
│  ● @koi/engine (L1) — createKoi (E2E tests only)     │
│  ● @koi/engine-loop — createLoopAdapter (tests only)  │
└───────────────────────────────────────────────────────┘
```

### Layer Position

```
L0  @koi/core ────────────────────────────────────────┐
    Tool, ToolDescriptor, ComponentProvider,            │
    KoiError, Result, JsonObject, TrustTier             │
                                                        │
                                                        ▼
L2  @koi/tools-github ◄────────────────────────────────┘
    imports from L0 only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✗ zero external npm dependencies
    ✓ gh CLI types stay internal (never leak to public API)
    ✓ All interface properties readonly
```

### Internal Structure

```
createGithubProvider(config)
│
├── config.executor      → GhExecutor (injected)
├── config.prefix        → "github" (default)
├── config.trustTier     → "verified" (default)
├── config.operations    → all 5 (default)
│
└── attach(agent) → Map<SubsystemToken, Tool | SkillComponent>
    │
    ├── toolToken("github_pr_create")  → createGithubPrCreateTool(executor, prefix, "promoted")
    ├── toolToken("github_pr_status")  → createGithubPrStatusTool(executor, prefix, "verified")
    ├── toolToken("github_pr_review")  → createGithubPrReviewTool(executor, prefix, "promoted")
    ├── toolToken("github_pr_merge")   → createGithubPrMergeTool(executor, prefix, "promoted")
    ├── toolToken("github_ci_wait")    → createGithubCiWaitTool(executor, prefix, "verified")
    └── skillToken("github")           → SkillComponent { name, description, content, tags }

Trust tiers:
  Read operations  (pr_status, ci_wait)   → configTier (default: "verified")
  Write operations (pr_create, pr_review, pr_merge) → "promoted"
```

---

## Tools Reference

### 5 Tools

```
╔════════════════════╦═══════════╦═════════════════════════════════════════════╗
║ Tool               ║ Trust     ║ Purpose                                     ║
╠════════════════════╬═══════════╬═════════════════════════════════════════════╣
║ github_pr_create   ║ promoted  ║ Create a new PR (title, body, base, draft) ║
║ github_pr_status   ║ verified  ║ Get PR state, CI, reviews, merge readiness ║
║ github_pr_review   ║ promoted  ║ Read reviews or post a new review          ║
║ github_pr_merge    ║ promoted  ║ Merge PR (merge/squash/rebase strategy)    ║
║ github_ci_wait     ║ verified  ║ Poll CI checks until done or timeout       ║
╚════════════════════╩═══════════╩═════════════════════════════════════════════╝
```

### Input Schemas

```
github_pr_create
  ├── title?        string    PR title (auto-generated from commits if omitted)
  ├── body?         string    PR description
  ├── base?         string    Base branch (default: repo default)
  ├── head?         string    Head branch (default: current)
  └── draft?        boolean   Create as draft (default: false)

github_pr_status
  └── pr_number     number    (required) Pull request number

github_pr_review
  ├── pr_number     number    (required) Pull request number
  ├── action        string    (required) "read" | "post"
  ├── body?         string    Review body (required for REQUEST_CHANGES)
  └── event?        string    "APPROVE" | "REQUEST_CHANGES" | "COMMENT"

github_pr_merge
  ├── pr_number     number    (required) Pull request number
  ├── strategy?     string    "merge" | "squash" | "rebase" (default: "merge")
  └── delete_branch? boolean  Delete head branch after merge (default: false)

github_ci_wait
  ├── pr_number     number    (required) Pull request number
  ├── timeout_ms?   number    Max wait (default: 600000, max: 1800000)
  ├── poll_interval_ms? number  Poll interval (default: 10000, min: 5000)
  └── fail_fast?    boolean   Stop on first failure (default: false)
```

---

## Error Handling

All tool errors return structured `{ code, error }` objects — never throw.

```
╔══════════════╦═══════════════════════════════╦═══════════╦═══════════════════════╗
║ Code         ║ Meaning                       ║ Retryable ║ Agent action          ║
╠══════════════╬═══════════════════════════════╬═══════════╬═══════════════════════╣
║ VALIDATION   ║ Bad argument or precondition  ║ No        ║ Fix args and retry    ║
║ NOT_FOUND    ║ PR or resource doesn't exist  ║ No        ║ Check PR number       ║
║ PERMISSION   ║ Insufficient gh permissions   ║ No        ║ Check gh auth status  ║
║ CONFLICT     ║ PR exists / merge conflict    ║ No        ║ Resolve conflicts     ║
║ RATE_LIMIT   ║ GitHub API rate limit         ║ Yes       ║ Wait and retry        ║
║ EXTERNAL     ║ CLI or network failure        ║ No        ║ Check connectivity    ║
╚══════════════╩═══════════════════════════════╩═══════════╩═══════════════════════╝

Error mapping pipeline:
  gh stderr → parseGhError() → KoiError → mapErrorResult() → { code, error }
```

---

## Usage

### With Full L1 Runtime (createKoi)

```typescript
import { createGhExecutor, createGithubProvider } from "@koi/tools-github";
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";

// 1. Create executor (validates gh is installed)
const executor = await createGhExecutor({ cwd: "/path/to/repo" });

// 2. Create component provider
const provider = createGithubProvider({ executor });

// 3. Assemble runtime — tools are attached via ECS
const runtime = await createKoi({
  manifest: {
    name: "pr-bot",
    version: "1.0.0",
    model: { name: "anthropic:claude-sonnet" },
  },
  adapter,
  providers: [provider],
});

// 4. Tools are now discoverable
runtime.agent.has(toolToken("github_pr_status")); // true
runtime.agent.has(toolToken("github_pr_merge"));  // true

// 5. Run — LLM discovers and calls tools through middleware chain
for await (const event of runtime.run({ kind: "text", text: "Check PR #42" })) {
  // tool_call_start, tool_call_end, text_delta, done...
}
```

### Standalone Tool Usage

```typescript
import { createGhExecutor, createGithubPrStatusTool } from "@koi/tools-github";

const executor = await createGhExecutor();
const tool = createGithubPrStatusTool(executor, "github", "verified");

const result = await tool.execute({ pr_number: 42 });
// → { state: "OPEN", reviewDecision: "APPROVED", ... }
```

### Custom Operation Subset

```typescript
const provider = createGithubProvider({
  executor,
  operations: ["pr_status", "ci_wait"],  // read-only tools only
  prefix: "gh",                            // → gh_pr_status, gh_ci_wait
  trustTier: "promoted",                   // override default trust
});
```

### Mock Executor for Tests

```typescript
import {
  createMockGhExecutor,
  mockSuccess,
  mockError,
} from "@koi/tools-github";

const executor = createMockGhExecutor([
  mockSuccess({ state: "OPEN", reviewDecision: "APPROVED" }),
  mockError("RATE_LIMIT", "API rate limit exceeded"),
]);

// First call returns success, second returns rate limit error
```

---

## Testing

### Test Structure

```
packages/tools-github/src/
  tools/
    pr-create.test.ts            Happy path, validation errors, executor errors
    pr-status.test.ts            Happy path, validation, JSON parse errors
    pr-review.test.ts            Read + post actions, REQUEST_CHANGES body check
    pr-merge.test.ts             Pre-validation, draft PR, merge conflicts
    ci-wait.test.ts              Polling, timeout, fail_fast, abort signal
  parse-gh-error.test.ts         stderr → KoiError mapping (all 6 codes)
  __tests__/
    github-component-provider.test.ts  Provider attach, operation subset, prefix
    e2e-full-stack.test.ts             CI-safe: scripted model through full L1
    e2e-real-llm.test.ts               Real Anthropic API through full L1
```

### Test Tiers

```
Tier 1: Unit tests (always run in CI)
═══════════════════════════════════════
  93 tests across 8 files
  ● Per-tool: happy path + validation errors + executor errors
  ● Error mapping: stderr patterns → KoiError codes
  ● Provider: ECS attachment, operation filtering, prefix override

Tier 2: CI-safe E2E (always run in CI, no API key)
═══════════════════════════════════════════════════
  9 tests in e2e-full-stack.test.ts
  ● Scripted model call → deterministic tool calls
  ● Full pipeline: createKoi → middleware → tool execute → event stream
  ● Error paths: RATE_LIMIT, NOT_FOUND, PERMISSION flow through chain
  ● Multi-tool: status → merge with pre-validation

Tier 3: Real LLM E2E (opt-in, needs ANTHROPIC_API_KEY)
═══════════════════════════════════════════════════════
  8 tests in e2e-real-llm.test.ts
  ● Real Claude Haiku calls with tool schemas
  ● LLM discovers tools, calls correct tool, uses results
  ● Multi-tool reasoning: status → merge decision
  ● Middleware wrapToolCall fires for real LLM calls

  Run: E2E_TESTS=1 bun --env-file=.env test e2e-real-llm
```

### Coverage

113 tests total, 0 failures. Unit + CI-safe E2E run on every build. Real LLM tests gated behind `E2E_TESTS=1`.

```bash
# Unit + CI-safe E2E (default)
bun --cwd packages/tools-github test

# Everything including real LLM
E2E_TESTS=1 bun --env-file=.env --cwd packages/tools-github test

# Full pipeline (build + typecheck + lint + test)
bun turbo run build typecheck lint test --filter=@koi/tools-github
```

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| `GhExecutor` interface (not direct `Bun.spawn`) | Enables mock injection in tests; same interface for real CLI and test doubles |
| ComponentProvider pattern | Tools attach via ECS — any engine adapter discovers them with zero engine changes |
| Trust tiers: reads verified, writes promoted | Reads are safe to auto-approve; writes (create, review, merge) need explicit permission |
| Pre-validation in `pr_merge` | Checks draft status, CI, merge conflicts BEFORE attempting merge — avoids partial failures |
| `parseGhError` maps stderr patterns | Structured `KoiError` codes enable LLM-driven error handling ("rate limited → wait and retry") |
| No external dependencies | `gh` CLI is the only external dependency; zero npm packages beyond `@koi/core` |
| Auto-attached `SkillComponent` | Provider attaches `skill:github` with PR best practices — engines inject it into the system prompt automatically. `GITHUB_SYSTEM_PROMPT` is deprecated; no manual wiring needed |
| Configurable prefix and operation subset | Same provider works for `github_*`, `gh_*`, or read-only subsets |
| CI-safe E2E via scripted model | Validates full assembly pipeline without API keys — catches integration regressions in CI |
| Sequential mock executor (queue) | Deterministic test ordering; routing executor for non-deterministic LLM tests |

---

## Layer Compliance

```
L0  @koi/core ────────────────────────────────────────┐
    Tool, ToolDescriptor, ComponentProvider,            │
    SkillComponent, skillToken,                         │
    KoiError, Result, JsonObject, TrustTier,            │
    toolToken, agentId                                  │
                                                        │
                                                        ▼
L2  @koi/tools-github ◄────────────────────────────────┘
    imports from L0 only (runtime)
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✗ zero external npm dependencies
    ✓ GhExecutor is a plain interface (no vendor types)
    ✓ All interface properties readonly
    ✓ Tool execute returns Result-shaped objects (never throws)
    ✓ Engine adapter agnostic (works with loop, Pi, LangGraph)

Dev-only imports (test files only):
    @koi/engine      — createKoi (E2E assembly)
    @koi/engine-loop — createLoopAdapter (scripted model)
```
