# Koi — Project Rules

## Runtime & Toolchain

| Tool | Choice | Wrong alternative |
|------|--------|-------------------|
| Runtime | Bun 1.3.x | Node.js |
| Package manager | `bun install` | npm, pnpm, yarn |
| Test runner | `bun:test` | Vitest, Jest |
| Build | tsup (ESM-only, .d.ts) | tsc emit, esbuild direct |
| Orchestration | Turborepo | Nx, Lerna |
| Lint/Format | Biome | ESLint, Prettier |
| CI lockfile | `bun install --frozen-lockfile` | never mutate lockfile in CI |

When writing scripts, commands, or configs — always use the **Choice** column. Never introduce anything from the **Wrong alternative** column.

## TypeScript 6 (strict, no exceptions)

**Current version: TypeScript 6.0.x** — all TS 6 defaults are set explicitly in `tsconfig.base.json`.

All flags are on. Do not weaken them. When writing new code:

- `strict: true` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`
- `verbatimModuleSyntax` — always use `import type` for type-only imports
- `isolatedDeclarations` — always write explicit return types on exported functions
- `erasableSyntaxOnly` — no constructs with runtime behavior (see banned list)
- `noUncheckedSideEffectImports` — side-effect imports (`import "./polyfill"`) must resolve
- **ESM-only** with `.js` extensions in all import paths (e.g., `import { foo } from "./bar.js"`)
- **ES2025 lib** — `Promise.try`, Set methods, iterator helpers, `RegExp.escape` types available

### TS 6 migration status

| Item | Status | Notes |
|------|--------|-------|
| `ignoreDeprecations: "6.0"` | Temporary | tsup DTS builds use `baseUrl` internally. Remove once tsup fixes. **Must remove before TS 7.** |
| `esModuleInterop` | Removed | TS 6 forces `true`; setting `false` is a deprecation error |
| `lib: ES2025` | Done | Upgraded from ES2023 |
| `noUncheckedSideEffectImports` | Done | Explicitly set (new TS 6 default) |
| All other TS 6 defaults | Explicit | `strict`, `target`, `module`, `moduleResolution`, `types`, `rootDir` all set — immune to default changes |

### TS 7 preparation

TypeScript 7 is a native Go port. All TS 6 deprecations become **hard removals**:
- `ignoreDeprecations: "6.0"` will stop working — resolve all deprecations before upgrading
- `baseUrl` will be removed — tsup must fix its DTS generation first
- `--module amd/umd/system/none` removed — already not used
- `--moduleResolution node10/classic` removed — already using `NodeNext`
- Import assertions (`assert`) removed — use import attributes (`with`) syntax

### Banned TypeScript constructs

| Banned | Use instead |
|--------|-------------|
| `enum` | `as const` object or string union type |
| `namespace` | ES modules |
| `any` | `unknown` + type narrowing |
| `as Type` assertion | Type guards, `satisfies`, or discriminated unions |
| `!` non-null assertion | Proper null/undefined checks |
| `@ts-ignore` | `@ts-expect-error` (self-cleaning: fails when error is fixed) |
| Constructor parameter properties | Explicit `readonly` field declarations |
| `class` (default) | Plain functions + types. Use `class` only when state encapsulation is genuinely needed |
| `import ... assert {}` | `import ... with {}` (import attributes — TS 6 removed assertion syntax) |
| `esModuleInterop: false` | Removed — TS 6 forces `true` |
| `allowSyntheticDefaultImports: false` | Removed — TS 6 forces `true` |

## Bun-specific

When working with Bun in this monorepo:

- `bunfig.toml` is the single config for install, test, and run — no `jest.config`, no `vitest.config`, no `.npmrc`
- `linker = "isolated"` — each package can only import its own declared dependencies. If you get a "module not found" error, the package is missing a dependency in its `package.json`, not a hoisting issue
- `trustedDependencies` in root `package.json` — audit every entry; each is a security surface. Only add packages that genuinely need postinstall scripts (e.g., esbuild)
- `bun.lock` (text JSONC) is committed to git — never gitignore it, never use binary `bun.lockb`
- Use `bun add --cwd packages/<name> <dep>` to install into a specific workspace (not the root)
- Bun runs `.ts` natively — no `ts-node`, no `tsx`, no build step for development
- Auto-loads `.env` files — no `dotenv` package needed

## Architecture — Four-Layer System

Koi is a self-extending agent engine with a strict layered architecture. Layer violations are build errors.

```
L0  @koi/core       Interfaces-only kernel. Types + contracts. Zero logic. Zero deps.
L1  @koi/engine      Kernel runtime. Guards, lifecycle, middleware composition. Depends on L0 + L0u.
L2  @koi/*           Feature packages. Each depends on L0 only. Never on L1 or L2 peers.
L3  Meta-packages    Convenience bundles (e.g., @koi/starter = L0 + L1 + selected L2).
```

### What goes where (agent guide)

**When creating or editing `@koi/core` (L0):**
- ONLY `type`, `interface`, and `readonly` const type definitions
- NO function bodies, NO classes, NO side effects, NO runtime code
  - Exception: branded type constructors (identity casts for `SubsystemToken<T>`) are permitted in L0 as they are zero-logic operations that exist purely for type safety
  - Exception: pure `readonly` data constants derived from L0 type definitions (e.g., `RETRYABLE_DEFAULTS`) are permitted as they codify architecture-doc invariants with zero logic
  - Exception: pure functions operating only on L0 types (type guards like `isProcessState`, validation helpers like `validateNonEmpty`, error factories) are permitted as they are side-effect-free data constructors
- NO `import` from any `@koi/*` package or external dependency
- This package must compile with zero dependencies in `package.json`
- Target: ~230+ types across 7 contracts + ECS layer, ~14,100 LOC (62 files, 27 export entry points)
- Think of it as the Linux syscall table — it defines the plugs, not the things that plug in

**When creating or editing `@koi/engine` (L1):**
- Runtime logic: factory functions, guards (iteration/loop/spawn), middleware chain composition, lifecycle state machine
- Import from `@koi/core` (L0) and L0-utility packages (L0u) — never from any L2 package
- Engine *adapters* (e.g., LangGraph, OpenAI) are L2 packages, not part of L1
- L1 IS the kernel runtime — it validates, guards, and dispatches but never knows which adapter is running

**When creating or editing feature packages (L2):**
- Import from `@koi/core` (L0) and L0-utility packages (L0u) only — never from `@koi/engine` or other L2 packages
- L0u packages (11 total — canonical list in `scripts/layers.ts`): `@koi/edit-match`, `@koi/errors`, `@koi/event-delivery`, `@koi/execution-context`, `@koi/file-resolution`, `@koi/git-utils`, `@koi/hash`, `@koi/session-repair`, `@koi/shutdown`, `@koi/token-estimator`, `@koi/validation`
- L0u packages may import from `@koi/core` and from peer L0u packages
- Each L2 package is independent and swappable
- Examples: channel adapters, middleware implementations, engine adapters, MCP bridge
- If two L2 packages need shared code, extract it to a new L2 package or move the shared types to L0

**When creating meta-packages (L3):**
- Only re-export from L0 + L1 + selected L2 — no new logic
- L3 packages (canonical list in `scripts/layers.ts`): none currently (all v1 L3 packages archived)

### Core Contracts (L0)

The 7 contracts that define Koi's extension points:

| # | Contract | Purpose | Minimal surface |
|---|----------|---------|-----------------|
| 1 | **Middleware** | Sole interposition layer for model/tool calls | 7 optional hooks |
| 2 | **Message** | Inbound/outbound data format | `ContentBlock[]` |
| 3 | **Channel** | I/O interface to users | `send()` + `onMessage()` |
| 4 | **Resolver** | Discovery of tools/skills/agents | `discover()` + `load()` |
| 5 | **Assembly** | What an agent IS (manifest) | Declarative config |
| 6 | **Engine** | Swappable agent loop | `stream()` is the only required method |
| 7 | **AgentRegistry** | Agent lifecycle management | CAS transitions + `watch()` |

Plus the ECS compositional layer: `Agent` (entity), `SubsystemToken<T>` (typed component key), `ComponentProvider` (attaches components during assembly).

### Anti-Leak Rules

These rules prevent vendor/framework concepts from contaminating core interfaces:

- **No framework-isms in L0** — no LangGraph graphs/channels/checkpointers, no OpenAI handoffs, no vendor-specific concepts in `@koi/core`
- **One interposition layer** — `KoiMiddleware` is the ONLY way to intercept model/tool calls. No separate `EngineHooks`. Middleware wraps the engine adapter from outside
- **`custom` event is escape-hatch only** — observable for telemetry/UI, never required for correctness. If middleware must react to it, promote it to a stable `EngineEvent` kind
- **`EngineState.data` is `unknown`** — truly opaque, zero assumptions about adapter state structure
- **No direct agent-to-agent communication** — agents interact through World Services (gateway, event bus), never entity-to-entity

### Anti-Leak Checklist (verify before every PR)

- [ ] `@koi/core` has zero `import` statements from other packages
- [ ] No `function` bodies or `class` in `@koi/core` (types/interfaces only, except branded casts and pure data constants)
- [ ] No vendor types (LangGraph, OpenAI, etc.) in any L0 or L1 file
- [ ] L2 packages only import from `@koi/core` (L0) and L0u utilities, never from `@koi/engine` or peer L2
- [ ] All interface properties are `readonly`
- [ ] Engine adapter exposes zero framework-specific concepts in its public API
- [ ] Interfaces that may be backed by I/O return `T | Promise<T>`, not just `T`

## Code Principles

### Koi Design Principles

- **Interface-first kernel** — `@koi/core` defines contracts, not implementations
- **Minimal-surface contracts** — few required methods, all operations optional with sane defaults
- **Middleware = sole interposition layer** — one way to intercept, not two
- **Manifest-driven assembly** — declarative agent definition (YAML IS the agent)
- **ECS composition** — Agent = entity, Tool = component, Middleware = system
- **Vocabulary <= 10 concepts** — Agent, Channel, Tool, Skill, Middleware, Manifest, Engine, Resolver, Gateway, Node

### Async by Default for I/O-Bound Interfaces

When defining L0 interfaces or L2 contracts that may be backed by I/O (HTTP, database, filesystem, IPC):

- Return `T | Promise<T>` so implementations can be sync (in-memory) or async (network) without interface changes
- Callers must always `await` the result — `await` on a non-Promise value is a no-op
- Order cheap sync checks (cache lookups, expiry, validation) before the async call to fail fast
- Example: `ScopeChecker.isAllowed` returns `boolean | Promise<boolean>` — local glob matching is sync, Nexus ReBAC over HTTP is async, same interface for both

### Immutability (default)

When writing any code in this repo:

- All `interface` and `type` properties must be `readonly`
- All array parameters must be `readonly T[]`
- Use `as const` for literal config objects
- Return new objects — never mutate parameters or shared state
- `const` always; `let` requires justification in a comment
- No `Array.push()`, `Array.splice()`, or direct property assignment on shared objects

### Simplicity (KISS)

- No premature abstraction — build for today's requirements only
- Duplication > wrong abstraction (Rule of Three: don't abstract until 3rd occurrence)
- If it can be written in 20 lines, don't add a dependency
- One package = one sentence description; if you need "and", split it
- No barrel `index.ts` re-exports at scale — import directly from source modules

### Files

- 200-400 lines typical, 800 hard max
- Organize by feature/domain, not by type
- Colocate unit tests with source: `foo.ts` + `foo.test.ts` in same directory
- Integration tests in `__tests__/` directory

### Functions

- < 50 lines each
- < 4 levels of nesting
- Pure by default; label side effects explicitly
- No hardcoded values — use constants or config

## API Naming Conventions

| Pattern | Prefix | Examples |
|---------|--------|---------|
| Factory functions | `create*` | `createGateway`, `createAuditMiddleware` |
| Template/string output | `generate*` | `generateLaunchdPlist`, `generateSystemdUnit` |
| Type transformations | `map*` | `mapMcpToolToKoi`, `mapSdkMessage` |
| Config validation | `validate<Domain>Config` | `validatePayConfig`, `validateAuditConfig` |
| Algorithms | `compute*` | `computeBackoff`, `computeContentHash` |
| Type guards | `is*` | `isKoiError`, `isRetryable` |
| Config loading | `load*` | `loadManifest`, `loadConfig` |
| System inspection | `detect*` | `detectPlatform`, `detectBunPath` |
| Discriminated unions | `kind` field | `GatewayFrame.kind`, `NodeFrame.kind`, `EngineEvent.kind` |
| Default configs | `DEFAULT_*` | `DEFAULT_GATEWAY_CONFIG` |
| Branded ID constructors | `<concept>Id()` | `agentId()`, `sessionId()` |

Banned naming patterns:
- `build*` for factories (use `create*`)
- `calculate*` for algorithms (use `compute*`)
- `render*` for templates (use `generate*`)
- `*Async` suffix on factories (async is implementation detail)
- Bare `validateConfig` (qualify with domain: `validate<Domain>Config`)
- `*To*` for transforms (use `map*` verb-first)

## Error Handling

When writing error handling code:

- **Expected failures** (validation, not-found, conflict): return typed values (`Result<T, E>` or discriminated unions). Do not throw.
- **Unexpected failures** (infra, OOM, bugs): throw with ES2022 `cause` chaining
- Always `catch (e: unknown)` — never `catch (e: any)` or bare `catch (e)`
- No empty catch blocks — every catch must log with context, re-throw, or convert to typed error
- Error messages must answer: what happened + why + what to do about it

```typescript
// Good — expected failure: return Result<T, E>
// (assumes userId: string, User is the domain type)
const error: KoiError = {
  code: "NOT_FOUND",
  message: "User not found",
  retryable: RETRYABLE_DEFAULTS.NOT_FOUND,
  context: { resourceId: userId },
};
return { ok: false, error } satisfies Result<User>;

// Good — unexpected failure: throw with cause chaining
// (L1 @koi/engine will provide a concrete Error class)
throw new Error("Failed to fetch user", { cause: err });

// Bad — never do these
catch (e) { console.log(e); }
catch (e) { /* ignore */ }
catch (e) { return null; }
```

## Type Patterns

Use these patterns when modeling domain types:

### Branded Types (for domain identity)

Prevent mixing IDs of different domains at compile time:

```typescript
declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]: B };
type UserId = Brand<string, "UserId">;
type AgentId = Brand<string, "AgentId">;
```

### Discriminated Unions (for state modeling)

Model all state with exhaustive discriminated unions:

```typescript
type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };
```

### satisfies (for validated constants)

Validate shape without widening type:

```typescript
const ERROR_CODES = {
  NOT_FOUND: "NOT_FOUND",
  TIMEOUT: "TIMEOUT",
} as const satisfies Record<string, string>;
```

## Testing

When writing or modifying tests:

- Runner: `bun:test` — config lives in `bunfig.toml`, no separate test config files
- Coverage threshold: 80% lines, functions, and statements (enforced in `bunfig.toml`)
- Test business logic and error paths — not implementation details or framework glue
- Every bug fix must include a regression test that would have caught the bug
- Use `mock()` and `spyOn()` from `bun:test` — no external mock libraries
- `beforeEach` to reset state — never depend on test execution order
- Use `describe()` blocks matching the module/function under test
- Name tests as behavior: `"returns error when user not found"`, not `"test case 1"`

## Security (verify before every PR)

- [ ] No hardcoded secrets (API keys, passwords, tokens) in source
- [ ] All external input validated at system boundary (schema validation with Zod or similar)
- [ ] Parameterized queries only — no string concatenation for SQL/NoSQL
- [ ] No secrets in `bunfig.toml` or committed config — use `.env` or secret manager
- [ ] Every new dependency justified, audited, and reviewed for maintenance status
- [ ] Error messages don't leak internal paths, stack traces, or sensitive data to users
- [ ] Fail closed — deny by default on auth/authz errors. If the check throws, deny access
- [ ] Rate limiting on all public-facing endpoints

## Dependencies

When considering adding a dependency:

- Fewer deps = smaller attack surface. Every transitive dep is a trust decision
- Prefer Bun/platform APIs first: `fetch`, `crypto`, `Bun.serve()`, `Bun.file()`, `Bun.password`
- Every new dep requires: (1) justification why it can't be written in-house, (2) maintenance/security check, (3) confirmation it doesn't duplicate existing functionality
- Pin exact versions (`exact = true` in `bunfig.toml`)
- Review lockfile diffs in PRs — they are security events
- If a function is < 50 lines, write it yourself instead of installing a package

## Workflow Orchestration

### 1. Plan Mode Default

- Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions)
- If something goes sideways, STOP and re-plan immediately — don't keep pushing
- Use plan mode for verification steps, not just building
- Write detailed specs upfront to reduce ambiguity

### 2. Subagent Strategy

- Use subagents liberally to keep main context window clean
- Offload research, exploration, and parallel analysis to subagents
- For complex problems, throw more compute at it via subagents
- One task per subagent for focused execution

### 3. Self-Improvement Loop

- After ANY correction from the user: update `tasks/lessons.md` with the pattern
- Write rules for yourself that prevent the same mistake
- Ruthlessly iterate on these lessons until mistake rate drops
- Review lessons at session start for relevant project

### 4. Verification Before Done

- Never mark a task complete without proving it works
- Diff behavior between main and your changes when relevant
- Ask yourself: "Would a staff engineer approve this?"
- Run tests, check logs, demonstrate correctness

### 5. Demand Elegance (Balanced)

- For non-trivial changes: pause and ask "is there a more elegant way?"
- If a fix feels hacky: "Knowing everything I know now, implement the elegant solution"
- Skip this for simple, obvious fixes — don't over-engineer
- Challenge your own work before presenting it

### 6. Autonomous Bug Fixing

- When given a bug report: just fix it. Don't ask for hand-holding
- Point at logs, errors, failing tests — then resolve them
- Zero context switching required from the user
- Go fix failing CI tests without being told how

## Task Management

1. **Plan First**: Write plan to `tasks/todo.md` with checkable items
2. **Verify Plan**: Check in before starting implementation
3. **Track Progress**: Mark items complete as you go
4. **Explain Changes**: High-level summary at each step
5. **Document Results**: Add review section to `tasks/todo.md`
6. **Capture Lessons**: Update `tasks/lessons.md` after corrections

## Core Principles

- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **Minimal Impact**: Changes should only touch what's necessary. Avoid introducing bugs.
- **Minimalistic & Elegant**: Write the least code that solves the problem correctly. No over-engineering, no unnecessary abstraction. If it can be 10 lines, don't write 50.

## Feature References

When designing new features (hooks, permissions, plugins, skills, etc.), cross-reference
with the decompiled Claude Code source for best-practice patterns and battle-tested design:

- **Source**: https://github.com/windoliver/claude-code-source-code
- **Key areas**: `src/utils/hooks/` (hook system), `src/schemas/` (Zod schemas), `src/utils/permissions/` (permission model), `src/utils/skills/` (skill runtime)
- **Use for**: architectural patterns, event taxonomies, security constraints (SSRF guards, env-var allowlisting, policy tiers), hook lifecycle design
- **Do not**: copy code verbatim — adapt patterns to Koi's layered architecture (L0/L1/L2)

## v2 Rewrite

Architecture plan: `.claude/plans/v2-rewrite.md` — **read before any v2 work**.

### Development Workflow (enforced)

Every PR follows **Doc → Tests → Code**. No exceptions.

| Step | What | Enforced By |
|------|------|-------------|
| 1. Doc | Write/update `docs/L2/<package>.md` before code | CI: doc-gate check |
| 2. Tests | Write failing tests that define behavior | CI: coverage ≥ 80%, no test deletion |
| 3. Code | Implement minimal code to pass tests | CI: typecheck + lint + check:layers |
| 4. Refactor | Clean up (< 400 lines/file, < 50 lines/fn) | CI: complexity check |

### Code Quality Rules

- Every file < 400 lines (800 hard max)
- Every function < 50 lines
- No duplication (5+ duplicated lines = CI fail)
- No premature abstraction — Rule of Three
- No feature flags — each capability is a package you include or don't
- Prefer 10 clear lines over 3 clever ones

### CI Gate (all must pass)

```bash
bun run test              # unit + contract tests
bun run typecheck         # strict TS compilation
bun run lint              # Biome lint
bun run check:layers      # L0/L1/L2/L3 dependency enforcement
bun run check:unused      # no dead exports
bun run check:duplicates  # no copy-paste blocks
```

### Agent Rules

- NEVER write code without a failing test first
- NEVER delete or weaken existing tests to make CI pass
- NEVER skip `check:layers` — layer violations are the #1 regression
- ALWAYS read `.claude/plans/v2-rewrite.md` before starting v2 work
- ALWAYS read `docs/L2/<package>.md` before modifying a package
- ALWAYS run affected tests before submitting (`bun run test --filter=<package>`)
- ALWAYS research the v1 archive before building a new v2 package — check `archive/v1/packages/` for the equivalent v1 implementation. Study its patterns, types, tests, and edge cases. Port what works, simplify what was over-engineered, and document what you learned in the PR description
- ALWAYS check `archive/v1/packages/meta/` (cli, koi, forge, starter) — these L3/L4 meta-packages show how v1 wired everything together: feature composition, middleware stacking, command dispatch, E2E test patterns, and real-world integration edge cases. They are the best reference for how packages interact at the integration boundary

### Golden Query & Trajectory Rule (every new L2 package)

Every new L2 package PR **must** be wired into `@koi/runtime` with golden query coverage. No exceptions.

**The flow:**

| Step | What | How |
|------|------|-----|
| 1. Wire | Add package as `@koi/runtime` dependency | `packages/meta/runtime/package.json` + `tsconfig.json` |
| 2. Query config | Add a golden query to the recording script | `packages/meta/runtime/scripts/record-cassettes.ts` — add a `QueryConfig` entry |
| 3. Record | Run real LLM + real tools to produce ATIF trajectory | `OPENROUTER_API_KEY=... bun run packages/meta/runtime/scripts/record-cassettes.ts` |
| 4. Validate | Add trajectory assertions to golden-replay tests | `packages/meta/runtime/src/__tests__/golden-replay.test.ts` |
| 5. Standalone | Add 2 per-L2 golden queries (no LLM needed) | Same file — `describe("Golden: @koi/<name>", ...)` |

**CI enforces (all must pass):**
```bash
bun run check:orphans          # L2 must be dep of @koi/runtime
bun run check:golden-queries   # L2 must have golden query assertions
bun run test --filter=@koi/runtime  # Full-loop replay: cassette → createKoi → live ATIF
```

**Recording produces:**
- `fixtures/<name>.cassette.json` — VCR replay (ModelChunk[] from real LLM)
- `fixtures/<name>.trajectory.json` — Full ATIF v1.6 document with all L2 observable output

**CI replay test runs the full agent loop without LLM or network:**
1. Load cassette chunks (mock LLM response)
2. Build mock adapter with cassette as `modelStream` terminal
3. Wire ALL L2 middleware (event-trace, hooks, permissions, etc.) via `createKoi`
4. Run agent loop → tool execution → second model call
5. Validate live ATIF trajectory: MCP steps, MW spans, hook steps, model steps, tool steps

**Current golden queries (5):**
| Query | What it covers |
|-------|---------------|
| simple-text | Text response, no tools, MW:permissions, MCP lifecycle |
| tool-use | add_numbers via buildTool, hooks fire, MW spans, model→tool→model |
| glob-use | Glob builtin tool called, returns file paths |
| permission-deny | Permissions default mode denies tool, model explains unavailable |
| web-fetch | web_fetch real HTTP call, SSRF protection, Example Domain |

**Re-record when:**
- New L2 package adds tools or middleware
- Tool behavior changes (args, output format)
- Hook event names change
- Model adapter response format changes

## Tmux (parallel agent safety)

Multiple Claude Code agents run in parallel across worktrees. **Always** prefix tmux session names with the worktree slug to avoid conflicts:

```bash
WORKTREE=$(basename "$PWD")   # e.g. "zany-popping-fountain"
tmux new-session -d -s "${WORKTREE}-koi" 'bun run packages/meta/cli/src/bin.ts up'
tmux capture-pane -t "${WORKTREE}-koi" -p
tmux send-keys -t "${WORKTREE}-koi" 'hello' Enter
```

| Correct | Wrong |
|---------|-------|
| `zany-popping-fountain-koi` | `koi` |
| `melodic-sprouting-kahan-nexus` | `nexus` |
| `${WORKTREE}-e2e` | `e2e`, `test`, `ace-test` |

**Never** use bare generic names. Another agent **will** rename or kill your session.

When tmux is unreliable, use the admin HTTP API as fallback:
```bash
curl -s http://localhost:3100/admin/api/health
```

## Git

- Commit format: `<type>: <description>` (feat, fix, refactor, docs, test, chore, perf, ci)
- PRs: < 300 lines of logic changes. Larger PRs get rubber-stamped — split them
- `bun.lock` always committed (text JSONC, git-friendly)
- Never force-push to main
