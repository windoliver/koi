# Koi — Project Rules

## Runtime & Toolchain

- **Runtime:** Bun 1.3.x (not Node.js)
- **Package manager:** `bun install` (not npm/pnpm/yarn)
- **Test runner:** `bun:test` (not Vitest/Jest)
- **Build:** tsup (ESM-only, .d.ts generation)
- **Orchestration:** Turborepo
- **Lint/Format:** Biome
- **CI:** `bun install --frozen-lockfile` — never mutate lockfile in CI

## TypeScript (strict, no exceptions)

All flags are on. Do not weaken them.

- `strict: true` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`
- `verbatimModuleSyntax` — use `import type` for type-only imports
- `isolatedDeclarations` — explicit return types on all exports
- **No `enum`** — use `as const` objects or string union types
- **No `namespace`** — use ES modules
- **No `any`** — use `unknown` + type narrowing
- **No `as Type` assertions** — use type guards or `satisfies`
- **No `!` non-null assertions** — use proper null checks
- **No `@ts-ignore`** — use `@ts-expect-error` (self-cleaning)
- **ESM-only** with `.js` extensions in import paths

## Bun-specific

- `bunfig.toml` is the single config for install, test, and run behavior
- `linker = "isolated"` — packages can only use declared dependencies
- `trustedDependencies` — audit every entry; each is an attack surface
- `bun.lock` (text JSONC) is committed — never gitignore it
- Use `bun add --cwd packages/foo <dep>` for workspace-targeted installs
- No `ts-node`, no `tsx`, no build step for dev — Bun runs .ts natively

## Code Principles

### Immutability (default)

- All interface/type properties are `readonly`
- All array params are `readonly T[]`
- Use `as const` for literal config objects
- Return new objects — never mutate parameters
- `const` always; `let` requires justification

### Simplicity (KISS)

- No premature abstraction — build for today's requirements
- Duplication > wrong abstraction (Rule of Three: don't abstract until 3rd occurrence)
- If it can be written in 20 lines, don't add a dependency
- One package = one sentence description; if you need "and", split it
- No barrel `index.ts` re-exports at scale — import from source modules

### Files

- 200-400 lines typical, 800 hard max
- Organize by feature/domain, not by type
- Colocate tests with source: `foo.ts` + `foo.test.ts`
- Integration tests in `__tests__/` directory

### Functions

- < 50 lines each
- < 4 levels of nesting
- Pure by default; label side effects explicitly
- No hardcoded values — use constants or config

## Error Handling

- **Expected failures** (validation, not-found): use typed return values (`Result<T, E>` or discriminated unions)
- **Unexpected failures** (infra, OOM): throw with `cause` chaining
- Always `catch (e: unknown)` — never `catch (e: any)` or bare `catch (e)`
- No empty catch blocks — every catch must log, re-throw, or convert
- Error messages: what happened + why + what to do

```typescript
// Good
throw new AppError("Failed to fetch user", {
  cause: err,
  code: "USER_FETCH_FAILED",
});

// Bad
catch (e) { console.log(e); }
catch (e) { /* ignore */ }
catch (e) { return null; }
```

## Type Patterns

### Branded Types (for domain identity)

```typescript
declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]: B };
type UserId = Brand<string, "UserId">;
```

### Discriminated Unions (for state modeling)

```typescript
type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };
```

### satisfies (for validated constants)

```typescript
const ROUTES = {
  home: "/",
  dashboard: "/dashboard",
} as const satisfies Record<string, string>;
```

## Testing

- Runner: `bun:test` — no config files, everything in `bunfig.toml`
- Coverage threshold: 80% (lines, functions, statements)
- Test business logic and error paths, not implementation details
- Every bug fix must include a regression test
- Use `mock()` and `spyOn()` from `bun:test` — no external mock libraries
- `beforeEach` to reset state — never depend on test execution order

## Security (pre-commit checklist)

- [ ] No hardcoded secrets (keys, passwords, tokens)
- [ ] All user input validated at boundary (schema validation)
- [ ] Parameterized queries only (no string concatenation for SQL)
- [ ] No secrets in bunfig.toml — use .env or secret manager
- [ ] Every new dependency justified and audited
- [ ] Error messages don't leak sensitive data
- [ ] Fail closed — deny by default on auth/authz errors

## Dependencies

- Fewer deps = smaller attack surface
- Prefer Bun/platform APIs: `fetch`, `crypto`, `Bun.serve()`, `Bun.file()`
- Every new dep requires: (1) justification, (2) maintenance check, (3) no duplication
- Pin exact versions (`exact = true` in bunfig.toml)
- Review lockfile diffs — they are security events

## Git

- Commit format: `<type>: <description>` (feat, fix, refactor, docs, test, chore, perf, ci)
- PRs: < 300 lines of logic changes
- `bun.lock` always committed
- Never force-push to main
