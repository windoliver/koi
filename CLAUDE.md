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

## TypeScript (strict, no exceptions)

All flags are on. Do not weaken them. When writing new code:

- `strict: true` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`
- `verbatimModuleSyntax` — always use `import type` for type-only imports
- `isolatedDeclarations` — always write explicit return types on exported functions
- `erasableSyntaxOnly` — no constructs with runtime behavior (see banned list)
- **ESM-only** with `.js` extensions in all import paths (e.g., `import { foo } from "./bar.js"`)

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
L1  @koi/engine      Kernel runtime. Guards, lifecycle, middleware composition. Depends on L0 only.
L2  @koi/*           Feature packages. Each depends on L0 only. Never on L1 or L2 peers.
L3  Meta-packages    Convenience bundles (e.g., @koi/starter = L0 + L1 + selected L2).
```

### What goes where (agent guide)

**When creating or editing `@koi/core` (L0):**
- ONLY `type`, `interface`, and `readonly` const type definitions
- NO function bodies, NO classes, NO side effects, NO runtime code
  - Exception: branded type constructors (identity casts for `SubsystemToken<T>`) are permitted in L0 as they are zero-logic operations that exist purely for type safety
- NO `import` from any `@koi/*` package or external dependency
- This package must compile with zero dependencies in `package.json`
- Target: ~45 types across 6 contracts + ECS layer, ~500 LOC
- Think of it as the Linux syscall table — it defines the plugs, not the things that plug in

**When creating or editing `@koi/engine` (L1):**
- Runtime logic: factory functions, guards (iteration/loop/spawn), middleware chain composition, lifecycle state machine
- Import from `@koi/core` only — never from any L2 package
- Engine *adapters* (e.g., LangGraph, OpenAI) are L2 packages, not part of L1
- L1 IS the kernel runtime — it validates, guards, and dispatches but never knows which adapter is running

**When creating or editing feature packages (L2):**
- Import from `@koi/core` only — never from `@koi/engine` or other L2 packages
- Each L2 package is independent and swappable
- Examples: channel adapters, middleware implementations, engine adapters, MCP bridge
- If two L2 packages need shared code, extract it to a new L2 package or move the shared types to L0

**When creating meta-packages (L3):**
- Only re-export from L0 + L1 + selected L2 — no new logic

### Core Contracts (L0)

The 6 contracts that define Koi's extension points:

| # | Contract | Purpose | Minimal surface |
|---|----------|---------|-----------------|
| 1 | **Middleware** | Sole interposition layer for model/tool calls | 8 optional hooks |
| 2 | **Message** | Inbound/outbound data format | `ContentBlock[]` |
| 3 | **Channel** | I/O interface to users | `send()` + `onMessage()` |
| 4 | **Resolver** | Discovery of tools/skills/agents | `discover()` + `load()` |
| 5 | **Assembly** | What an agent IS (manifest) | Declarative config |
| 6 | **Engine** | Swappable agent loop | `stream()` is the only required method |

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
- [ ] No `function` bodies or `class` in `@koi/core` (types/interfaces only)
- [ ] No vendor types (LangGraph, OpenAI, etc.) in any L0 or L1 file
- [ ] L2 packages only import from `@koi/core`, never from `@koi/engine` or peer L2
- [ ] All interface properties are `readonly`
- [ ] Engine adapter exposes zero framework-specific concepts in its public API

## Code Principles

### Koi Design Principles

- **Interface-first kernel** — `@koi/core` defines contracts, not implementations
- **Minimal-surface contracts** — few required methods, all operations optional with sane defaults
- **Middleware = sole interposition layer** — one way to intercept, not two
- **Manifest-driven assembly** — declarative agent definition (YAML IS the agent)
- **ECS composition** — Agent = entity, Tool = component, Middleware = system
- **Vocabulary <= 10 concepts** — Agent, Channel, Tool, Skill, Middleware, Manifest, Engine, Resolver, Gateway, Node

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

## Error Handling

When writing error handling code:

- **Expected failures** (validation, not-found, conflict): return typed values (`Result<T, E>` or discriminated unions). Do not throw.
- **Unexpected failures** (infra, OOM, bugs): throw with ES2022 `cause` chaining
- Always `catch (e: unknown)` — never `catch (e: any)` or bare `catch (e)`
- No empty catch blocks — every catch must log with context, re-throw, or convert to typed error
- Error messages must answer: what happened + why + what to do about it

```typescript
// Good — cause chaining with context
throw new KoiError("Failed to fetch user", {
  cause: err,
  code: "USER_FETCH_FAILED",
});

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

## Git

- Commit format: `<type>: <description>` (feat, fix, refactor, docs, test, chore, perf, ci)
- PRs: < 300 lines of logic changes. Larger PRs get rubber-stamped — split them
- `bun.lock` always committed (text JSONC, git-friendly)
- Never force-push to main
