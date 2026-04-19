# Per-Command Semantic Specs for `@koi/bash-ast`

**Issue:** [#1662](https://github.com/windoliver/koi/issues/1662)
**Branch:** `feat/issue-1662-bash-specs`
**Status:** Design approved 2026-04-18

## Summary

Add hand-written per-command specs to `@koi/bash-ast` that map a resolved
`argv: readonly string[]` (produced by the existing walker) to a
`CommandSemantics` summary — which paths the command reads, which paths it
writes, whether it makes a network call, and which env vars it mutates.
Covers nine high-value commands: `rm, cp, mv, chmod, chown, curl, wget,
tar, scp, ssh`.

This PR ships **specs only**. Consumer wiring (e.g.,
`@koi/security/middleware-permissions` calling specs to enforce
`Write($WORKSPACE/**)` rules) and the corresponding golden query land in
a follow-up tracked by a new issue.

## Why

Phase 1 of `@koi/bash-ast` (#1660) extracts a trustworthy `argv[]` and
stops there. Permission rules currently match on argv strings — sufficient
for "allow/deny by command name" but not for resource-aware rules like
"deny any write outside the workspace" or "deny any network egress". Those
need a per-command semantic summary.

A generic semantic walker is a research problem. A curated set of
per-command specs is tractable and grows command-by-command.

## Out of scope

- Consumer wiring into `@koi/security/middleware-permissions`.
- New permission rule shapes (`Write(path)`, `Read(path)`, `Network(host)`).
- Golden-query trajectory coverage.
- Path normalization or `cwd` resolution — caller's job (see Q2 below).
- Glob expansion — caller's job.
- ssh remote-command analysis — `ssh host "rm -rf /"` returns
  network-only; recursing into the remote command is out of scope.

## File layout

```
packages/lib/bash-ast/src/specs/
  types.ts          # CommandSemantics + CommandSpec
  parse-flags.ts    # shared flag parser (Rule of Three: 9 specs justify one helper)
  registry.ts       # BUILTIN_SPECS map + createSpecRegistry + registerSpec
  rm.ts             # specRm
  rm.test.ts
  cp.ts             # specCp
  cp.test.ts
  mv.ts
  mv.test.ts
  chmod.ts
  chmod.test.ts
  chown.ts
  chown.test.ts
  curl.ts
  curl.test.ts
  wget.ts
  wget.test.ts
  tar.ts
  tar.test.ts
  scp.ts
  scp.test.ts
  ssh.ts
  ssh.test.ts
  index.ts          # re-exports types, registry, and the nine spec functions
```

Each spec file < 80 lines (acceptance criterion). `parse-flags.ts` keeps
shared parsing in one place; without it, nine files would each
re-implement bundled-flag splitting and `--` handling.

`packages/lib/bash-ast/src/index.ts` adds a single line that re-exports
the new public surface from `./specs/index.js`.

## Public API

```typescript
// types.ts
export interface CommandSemantics {
  readonly reads: readonly string[];
  readonly writes: readonly string[];
  readonly network: readonly NetworkAccess[];
  readonly envMutations: readonly string[];
}

export interface NetworkAccess {
  readonly kind: "http" | "ssh" | "ftp";
  readonly target: string; // raw argv string — host or URL
}

export type CommandSpec = (argv: readonly string[]) => CommandSemantics | null;

// registry.ts
export const BUILTIN_SPECS: ReadonlyMap<string, CommandSpec>;
export function createSpecRegistry(): Map<string, CommandSpec>;
export function registerSpec(
  reg: Map<string, CommandSpec>,
  name: string,
  fn: CommandSpec,
): void;

// per-command files — direct named exports for tree-shaking + tests
export function specRm(argv: readonly string[]): CommandSemantics | null;
export function specCp(argv: readonly string[]): CommandSemantics | null;
export function specMv(argv: readonly string[]): CommandSemantics | null;
export function specChmod(argv: readonly string[]): CommandSemantics | null;
export function specChown(argv: readonly string[]): CommandSemantics | null;
export function specCurl(argv: readonly string[]): CommandSemantics | null;
export function specWget(argv: readonly string[]): CommandSemantics | null;
export function specTar(argv: readonly string[]): CommandSemantics | null;
export function specScp(argv: readonly string[]): CommandSemantics | null;
export function specSsh(argv: readonly string[]): CommandSemantics | null;
```

### Design decisions (questions resolved during brainstorming)

| # | Decision | Rationale |
|---|----------|-----------|
| Q1 | **Hybrid factory + named exports.** Exported `BUILTIN_SPECS: ReadonlyMap`, `createSpecRegistry()` returns fresh `Map` seeded with builtins, `registerSpec()` is a thin one-line helper. No class wrapper. | Matches current Koi main idiom (`createDefaultManifestRegistry`, `createMcpResolver`). No module-level mutable state. CLAUDE.md: "Use `class` only when state encapsulation is genuinely needed" — `Map` is the registry. |
| Q2 | **Verbatim argv strings in `reads`/`writes`/`network.target`.** No path normalization, no FS access, no glob expansion. Caller resolves relative→absolute against its own cwd. | Walker output is already static (no `$VAR`, no `$(…)`). Spec stays trivially pure. Matches issue example output verbatim. |
| Q3 | **Strict allowlist per command.** Each spec carries a curated set of recognized flags; unknown flag → `null`. | Issue criterion: "never guess". `null` lets caller fall back to deny-by-default — fail-closed. |
| Q4 | **Keep `envMutations` field; always `[]` for current 9.** | Matches issue contract. Documents "this command does NOT mutate env" rather than leaving implicit. Future-proofs for an `export`/`unset` spec without a breaking type change. |
| Q5 | **Skip golden query in this PR.** | New code is pure library helpers — no model call, no tool, no agent-observable side effect. Golden query lands with the consumer in a follow-up PR. |

## Per-command flag allowlists

| Command | Recognized flags | Returns `null` on |
|---|---|---|
| `rm` | `-r`/`-R`, `-f`, `-i`, `-d`, `-v`, `--` | unknown flag, missing positional |
| `cp` | `-r`/`-R`, `-f`, `-i`, `-p`, `-a`, `-v`, `-t DIR`, `-T`, `--` | unknown flag, missing source/dest |
| `mv` | `-f`, `-i`, `-n`, `-v`, `-t DIR`, `-T`, `--` | unknown flag, missing source/dest |
| `chmod` | `-R`, `-v`, `-f`, `--` + mode + path | unknown flag, missing mode or path |
| `chown` | `-R`, `-v`, `-f`, `--` + owner + path | unknown flag, missing owner or path |
| `curl` | `-o`/`--output FILE`, `-O`, `-L`, `-X METHOD`, `-d`/`--data`, `-H`, `-s`, `-i`, URL(s) | `--config`/`-K`, `--next`, `-T`, unknown flag |
| `wget` | `-O FILE`, `-q`, `-c`, `-N`, URL(s) | `-i`/`--input-file`, unknown flag |
| `tar` | `-x`/`-c`/`-t` (exactly one), `-f FILE`, `-z`/`-j`, `-C DIR`, `-v`, `--`, file list | mutually-exclusive mode flags, unknown flag, no `-f` (stdin) |
| `scp` | `-r`, `-p`, `-q`, `-i KEY`, src, dst (≥1 must be `host:path`) | unknown flag, both endpoints local |
| `ssh` | host (positional or `-l user host`), `-p PORT`, `-i KEY`, remote command (ignored) | unknown flag with required arg |

Long flags accept both `--output FILE` and `--output=FILE`. Bundled short
flags (`-rf` → `-r -f`) are split by `parse-flags.ts`.

## Spec semantics — per command

- **`rm`** — all positional paths → `writes` (rm is destructive). No reads, no network, no env.
- **`cp`** — all positionals except the last → `reads`; the last → `writes`. With `-t DIR`: `-t` value → `writes` directory; remaining positionals → `reads`. With `-T`: exactly two positionals required, treated as src→dst.
- **`mv`** — destructive on source. ALL positionals → `writes` (both source and destination paths change state: source disappears, destination appears). `reads: []`. With `-t DIR`: `-t` value + remaining positionals all → `writes`. This deliberately diverges from `cp`: a `Write($WORKSPACE/**)` rule must catch moves *out of* the workspace, which requires the source in `writes`.
- **`chmod`** — first positional is mode (not a path); remaining positionals → `writes` (permission change is a metadata write).
- **`chown`** — first positional is owner spec; remaining positionals → `writes`.
- **`curl`** — every URL positional → `network: { kind: "http", target: URL }`. With `-o FILE` or `-O`: target file → `writes`. With `-d @file`: `file` → `reads`. POST data inline (`-d 'key=val'`) does not produce a read.
- **`wget`** — every URL positional → `network: { kind: "http", target: URL }`. With `-O FILE`: file → `writes`. **Without `-O`**: `writes: []` — wget defaults to a basename derived from the URL, which requires URL parsing and would amount to guessing per the issue's "never guess" criterion. Caller can apply a coarser network rule.
- **`tar`** — `-x` extract: `-f FILE` → `reads`; positional file list → ignored; output written to `-C DIR` or cwd (we cannot know exact paths → return `writes: []` for `-x` since paths are inside the archive). `-c` create: `-f FILE` → `writes`; positional file list → `reads`. `-t` list: `-f FILE` → `reads`; no writes.
- **`scp`** — for each `host:path` endpoint: `network: { kind: "ssh", target: host }`; the local-side path → `reads` (if source) or `writes` (if dest).
- **`ssh`** — `network: { kind: "ssh", target: host }` only. No reads, no writes regardless of remote command.

## Testing strategy

- **Per-spec test file**: ≥ one positive case per recognized flag, one
  ambiguous case → `null`, one bundled-flags case (`-rf`), one `--`
  end-of-options case.
- **Registry test**: `BUILTIN_SPECS.size === 9` with exact name set;
  `createSpecRegistry()` returns mutable `Map` containing all builtins;
  `registerSpec()` adds entries; existing builtins remain after register.
- **`parse-flags.test.ts`**: invariants on the shared helper —
  bundling, value-flag termination, unknown-flag rejection, `--` cutoff.
- Coverage threshold remains 80% (CLAUDE.md / `bunfig.toml`).
- Test naming: behavior-style ("returns null when -t has no value"),
  not "test case 1".

## Docs

`docs/L2/bash-ast.md` gains a new section, **"Per-command semantics"**,
covering:

- Public API (types, registry, named spec exports).
- The nine commands + their flag allowlists (table above).
- The `null = analysis refused` contract and why callers must fail closed.
- An explicit note: consumer wiring + golden query land in a follow-up
  PR; pointer to the new tracking issue.

## Follow-up tracking issue

Title: **`@koi/security/middleware-permissions`: consume bash-ast specs for write/read/network rules**

Body sketch:

- References #1662 (this PR) and the soon-to-merge specs commit.
- Scope: extend `@koi/security/permissions` rule schema with
  `Write(path)`, `Read(path)`, `Network(host)` shapes;
  update `rule-evaluator.ts`; wire bash-aware path inside
  `middleware-permissions/middleware.ts` (or split that file first).
- Acceptance: golden query (`Bash(rm -rf ./tmp)` → spec → permission deny
  → trajectory reflects deny) wired into `@koi/runtime`.
- Risk note: `middleware-permissions/middleware.ts` is currently 2398
  lines (well past the 800 hard max); consumer wiring should refactor
  into smaller files first.

## Acceptance checklist (recap from issue)

- [ ] One spec file per target command, each < 80 lines.
- [ ] `spec*(argv)` returns `null` on ambiguous flags (never guess).
- [ ] Unit tests per spec covering flag variants, positional args, ambiguous cases.
- [ ] `registerSpec(name, fn)` exposed from `@koi/bash-ast`.
- [ ] `docs/L2/bash-ast.md` updated.
- [ ] CI green: `bun run test`, `typecheck`, `lint`, `check:layers`,
      `check:unused`, `check:duplicates`.
- [ ] Follow-up tracking issue opened for consumer + golden query.
