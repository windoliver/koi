# @koi/bash-ast

L0u package — AST-based bash command analysis for permission matching.

> Layered as L0u (not L2) so L2 packages like `@koi/tools-bash` can depend
> on it directly without breaking the layer rule "L2 may only import from
> L0 + L0u". Shares this layer with `@koi/bash-security`, which bash-ast
> imports for prefilter and transitional fallback.

## Purpose

Parses a raw bash command string into a trustworthy `argv[]` for each simple
command so the permissions evaluator can match on semantic structure instead of
fragile regex patterns. Answers exactly one question:

> *Can we produce a trustworthy argv[] for every simple command in this string?*

If **yes**, the caller gets a `SimpleCommand[]` with resolved argv, environment
variable assignments, and redirects. Downstream rule matching compares
`BashRulePattern` (from `@koi/core`) against each `argv`.

If **no**, the command is classified `too-complex` and routed through the
transitional fallback — the existing `@koi/bash-security` regex classifier —
until three-state permissions (#1622) lands and `too-complex` can route to an
`ask-user` verdict instead.

If parsing fails entirely (timeout, over-length, init failure), the result is
`parse-unavailable` and the caller **must fail closed**.

## Public API

```typescript
import type { BashRulePattern } from "@koi/core/bash-rule-pattern";
import {
  initializeBashAst,
  classifyBashCommand,
  matchSimpleCommand,
  type AstAnalysis,
  type SimpleCommand,
  type Redirect,
} from "@koi/bash-ast";

// One-time startup. Caches the init promise; idempotent under concurrent calls.
await initializeBashAst();

// Sync hot path once init has resolved.
const result: AstAnalysis = classifyBashCommand("git status --porcelain");

switch (result.kind) {
  case "simple": {
    // SimpleCommand[] — argv + envVars + redirects + source text
    for (const cmd of result.commands) {
      const pattern: BashRulePattern = { argv0: "git", argsPrefix: ["status"] };
      if (matchSimpleCommand(pattern, cmd)) {
        // allow
      }
    }
    break;
  }
  case "too-complex":
    // Transitional: fall back to @koi/bash-security regex classifier.
    // After #1622: route to ask-user verdict.
    break;
  case "parse-unavailable":
    // Fail closed — init not complete, parse timeout, over-length, or panic.
    break;
}
```

## Output shape

```typescript
type AstAnalysis =
  | { kind: "simple"; commands: readonly SimpleCommand[] }
  | { kind: "too-complex"; reason: string; nodeType?: string }
  | {
      kind: "parse-unavailable";
      cause: "not-initialized" | "timeout" | "over-length" | "panic";
    };

interface SimpleCommand {
  /** argv[0] is the command name, argv[1..] are resolved arguments. */
  readonly argv: readonly string[];
  /** Leading `VAR=val` assignments before the command name. */
  readonly envVars: readonly { readonly name: string; readonly value: string }[];
  /** Output/input redirects attached to this command. */
  readonly redirects: readonly Redirect[];
  /** Original source span for UI display and logging. */
  readonly text: string;
}
```

## Architecture

```
L2 @koi/bash-ast
  ├── src/
  │   ├── index.ts              Public barrel — types + init + classify + matcher
  │   ├── types.ts              AstAnalysis, SimpleCommand, Redirect
  │   ├── init.ts               initializeBashAst() — cached promise over web-tree-sitter
  │   ├── classify.ts           classifyBashCommand() — two-phase prefilter + walker + fallback
  │   ├── walker.ts             AST walker — allowlist-based, fail-closed on unknown nodes
  │   ├── matcher.ts            matchSimpleCommand() — pure argv matcher
  │   └── __tests__/            Unit + integration + fuzz tests
  └── vendor/
      └── tree-sitter-bash.wasm   Committed binary grammar asset (~1.3 MB)
```

Depends on:

| Dep | Layer | Purpose |
|-----|-------|---------|
| `@koi/core` | L0 | `BashRulePattern` type for matcher |
| `@koi/bash-security` | L0u | Prefilter (pre-parse byte checks) + transitional regex fallback |
| `web-tree-sitter` | external | WASM parser runtime |

## Fail-closed invariant

The module has one non-negotiable safety property: **any grammar node type that
the walker does not explicitly allowlist causes the entire command to be
classified `too-complex`**. Unknown syntax never produces an argv. This is the
single most important test in the package, covered by:

1. **Injected fake parser** — all failure modes (null, throw, timeout,
   not-initialized) must produce `parse-unavailable` with the correct `cause`
   discriminator; no branch falls through to a permissive path.
2. **Real parser, adversarial inputs** — deep `((a[0]…` nesting,
   over-length strings, invalid UTF-8, control characters. All must produce
   `parse-unavailable` or `too-complex`.
3. **fast-check fuzz** — 1000 random inputs per run; every outcome must be one
   of the three variants and no execution path may throw.

If any of these loosen, an attacker can craft input that tree-sitter fails to
parse yet the caller still treats as a simple command. The test suite is the
only thing standing between "fail closed" and "silently permissive."

## Two-phase prefilter

Cheap byte-level checks run **before** the tree-sitter parse to reject
obviously-malicious input in microseconds:

1. **Pre-parse** (from `@koi/bash-security`):
   - Null bytes (`\x00`) and other control characters
   - URL-encoded path traversal (`%2e%2e`, `%252e%252e`)
   - Hex-escaped ANSI-C strings (`$'\x72\x6d'`)
2. **Parse** — tree-sitter-bash builds the AST (50 ms timeout, 50K node
   budget; over-budget input → `parse-unavailable` with `cause: "timeout"`).
3. **Post-parse differential** — checks that need both raw bytes and the AST
   (e.g., zsh `~[name]` dynamic directory syntax, brace+quote obfuscation).
4. **Walk** — the allowlist-based walker extracts `SimpleCommand[]` or bails
   to `too-complex`.

## Phase-1 limitations (documented; deferred to follow-ups)

- **No variable scope tracking.** Any `$VAR`, `${VAR}`, or `$(...)` inside a
  command returns `too-complex`. Patterns like `NOW=$(date) && echo $NOW`
  are not statically analyzable and currently fall back to the regex
  classifier. A follow-up issue will evaluate shipping a scope tracker if
  prompt noise proves intolerable in practice.
- **No per-command semantic specs.** `SimpleCommand` tells you *"this is `cp`
  with these args"* — not *"this reads X and writes Y"*. A follow-up issue
  will add hand-written specs for `cp, mv, rm, curl, wget, tar, scp, ssh,
  chmod` if needed.
- **No wrapper-command specs.** Commands like `nohup`, `timeout`, `sudo`,
  `env` are analyzed as themselves — not as their inner command. A follow-up
  issue will add wrapper stripping.

## Transitional `too-complex` fallback

Until #1622 (three-state permissions) lands, `too-complex` commands route
through the existing `@koi/bash-security` regex classifier as a compatibility
fallback. This:

- **Preserves current behavior** for commands with `$()`, `$VAR`, loops, `&&`
- **Does not widen the attack surface** — the fallback runs the same checks
  these commands get today
- **Is explicitly transitional** — every fallback call site is marked
  `// TODO(#1622): remove when ask-user verdict exists`

When #1622 merges, the fallback is deleted and `too-complex` routes to an
interactive `ask-user` prompt.

## Testing

| Layer | What it proves |
|-------|----------------|
| Unit | Walker extracts argv/envVars/redirects correctly for each allowed node kind |
| Unit (fail-closed) | Every parser failure mode produces `parse-unavailable` |
| Integration | Adversarial real inputs (deep nesting, over-length, control chars) never produce `simple` |
| Fuzz (fast-check) | 1000 random strings; outcome always in `{simple, too-complex, parse-unavailable}`, no throws |
| Concurrent init | `Promise.all([classify(a), classify(b), classify(c)])` before init — asserts init runs exactly once |
| Bypass corpus | Every case from `@koi/bash-security/__tests__/bypass-cases.ts` mapped to expected AST outcome |

## Golden query coverage

Two golden queries in `@koi/runtime` exercise this package end-to-end:

- **`bash-exec`** (existing) — `echo hello-from-bash` reaches
  `kind: "simple"`, rule matches, command runs. Proves the happy path.
- **`bash-ast-too-complex`** (new) — `echo $USER` reaches
  `kind: "too-complex"`, falls through to the regex classifier, command
  runs. Proves the transitional fallback works. Will be updated in the #1622
  follow-up to assert an ask-user elicitation instead.

## WASM asset delivery

The tree-sitter-bash grammar is committed as a binary asset at
`packages/lib/bash-ast/vendor/tree-sitter-bash.wasm` (~1.3 MB) and loaded at
runtime via `new URL("../vendor/tree-sitter-bash.wasm", import.meta.url)`.
`tsup` copies the vendor directory into `dist/` at build time. The file is
refreshed by a one-time script that extracts it from
`@vscode/tree-sitter-wasm` (devDependency only).

Rebuilding the grammar file:

```sh
bun run packages/lib/bash-ast/scripts/refresh-grammar.ts
```

## Dependencies

- `@koi/core` (workspace) — L0 type contract
- `@koi/bash-security` (workspace) — prefilter + transitional regex fallback
- `web-tree-sitter` (external) — WASM parser runtime
