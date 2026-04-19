# Per-Command Semantic Specs for `@koi/bash-ast`

**Issue:** [#1662](https://github.com/windoliver/koi/issues/1662)
**Branch:** `feat/issue-1662-bash-specs`
**Status:** Design approved 2026-04-18

## Summary

Add hand-written per-command specs to `@koi/bash-ast` that map a resolved
`argv: readonly string[]` (produced by the existing walker) to a
`CommandSemantics` summary — which paths the command reads, which paths it
writes, whether it makes a network call, and which env vars it mutates.
Covers ten high-value commands: `rm, cp, mv, chmod, chown, curl, wget,
tar, scp, ssh`.

### Soundness contract — read this before consuming `CommandSemantics`

A `CommandSemantics` reports **only the facts derivable from argv
alone**. The `incomplete` flag is the machine-enforceable signal of
how much trust the consumer can place in the populated fields:

- **`incomplete: false`** (default): argv-derived accounting is complete
  for the I/O the command performs. Consumers MAY use this as the sole
  input to argv-aware rules (`Read(path)`, `Write(path)`,
  `Network(host)`).
- **`incomplete: true`**: at least one populated field is an
  under-approximation. Consumers MUST refuse to use this object as the
  sole input to argv-aware rules and MUST require a command-name
  (`Run(...)`) rule to govern the call. Examples:
    - `tar -x` — `writes: []` because extraction targets are inside the
      archive (and may escape `-C DIR` via absolute paths or `..`).
    - `ssh`/`scp` — literal host string may be a `Host` alias resolving
      elsewhere; `~/.ssh/config`, `known_hosts`, default identity files,
      and `Include`-pulled paths are not reported.
    - `wget` without `-O` — default-output basename is derived by wget
      from the URL; we don't guess.

`null` is reserved for **argv-structure failures**, not "some effect is
unknown": unparseable flag positions, missing required positionals,
mutually-exclusive mode flags in conflict, or unknown flags whose
value-consumption is unknown.

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
- ssh remote-command recursion — `ssh host "rm -rf /"` reports the
  network target and ignores the remote command (per the contract: argv
  facts only, no further interpretation of the remote string).

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
  index.ts          # re-exports types, registry, and the ten spec functions
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
  /**
   * When `true`, this `CommandSemantics` is known to be an
   * under-approximation: at least one of `reads`/`writes`/`network`
   * omits effects that argv-only analysis cannot resolve. Consumers
   * MUST refuse to use this object as the sole input to a `Read(path)`
   * / `Write(path)` / `Network(host)` decision and instead require
   * a command-name (`Run(...)`) rule to govern the call.
   *
   * Examples that set `incomplete: true`:
   *   - `tar -x …`   — extracted paths cannot be derived from argv
   *   - `ssh host …` — host may be a config `Host` alias; identity
   *                    files / known_hosts are read but not reported
   *   - `scp host:p .` — same alias / identity caveat as ssh
   *   - `wget URL`   — default-output basename derived by wget itself
   *
   * When `false` (default), the spec asserts its accounting is
   * complete for argv as parsed.
   */
  readonly incomplete?: boolean;
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
| Q2 | **Verbatim argv strings in `reads`/`writes`/`network.target`.** No path normalization, no FS access, no glob expansion. Caller resolves relative→absolute against its own cwd. Specs MUST NOT invent fake-path sentinels (`"."`) or hard-coded conventional paths to stand in for unknown I/O; refuse the analysis with `null` instead. | Walker output is already static (no `$VAR`, no `$(…)`). Spec stays trivially pure. Fake sentinels would conflate "wrote a file inside cwd" with "wrote the directory entry `.`" and mislead `Write(path)` rule evaluators. Hard-coded paths (e.g., `~/.ssh/*`) are unsound — they over-report (paths not actually touched) and under-report (config-driven alternates). |
| Q3 | **Strict allowlist per command for flag *parsing*; under-approximate I/O reporting.** Each spec carries a curated set of recognized flags. Unknown flag → `null` (we cannot tell whether it consumes the next argv). When parsing succeeds, the spec returns the I/O facts it can derive from argv; effects requiring config/FS resolution are silently omitted (see Soundness contract). | Issue criterion "never guess" applies to argv-shape parsing — guessing positional alignment under unknown flags is unsafe. But returning `null` for every command with unresolved downstream effects throws away argv facts that ARE knowable (URLs, hosts, literal paths) and prevents resource-aware enforcement on the common cases. |
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
| `tar` | `-x`/`-c`/`-t` (exactly one); `-f FILE`, `-z`/`-j`, `-C DIR`, `-v`, `--`, file list | mutually-exclusive mode flags, unknown flag, no `-f` (stdin) |
| `scp` | `-r`, `-p`, `-q`, `-v`, `-C`, `-4`, `-6`, `-A`, `-O`, `-T`, `-i KEY`, `-P PORT`, src, dst (≥1 must be `host:path`) | trust-boundary flags (`-o KEY=VAL`, `-F config`, `-J jump` — `ssh_config` `ProxyCommand` / `IdentityFile` / `Include` etc. can rewrite endpoint and local I/O); unknown flag; both endpoints local |
| `ssh` | host (positional or `-l user host`); boolean: `-A`, `-T`, `-t`, `-N`, `-q`, `-v`, `-X`, `-x`, `-C`, `-4`, `-6`; value: `-p PORT`, `-i KEY`; remote command (ignored) | trust-boundary flags (`-o KEY=VAL`, `-F config`, `-J jump`, `-D port`, `-L spec`, `-R spec` — port forwards add unreported network/local-listen surface; `ssh_config` overrides can rewrite the endpoint or trigger arbitrary local execution via `ProxyCommand`/`LocalCommand`); unknown flag with required arg |

Long flags accept both `--output FILE` and `--output=FILE`. Bundled short
flags (`-rf` → `-r -f`) are split by `parse-flags.ts`.

## Spec semantics — per command

- **`rm`** — all positional paths → `writes` (rm is destructive). No reads, no network, no env.
- **`cp`** — all positionals except the last → `reads`; the last → `writes`. With `-t DIR`: `-t` value → `writes` directory; remaining positionals → `reads`. With `-T`: exactly two positionals required, treated as src→dst.
- **`mv`** — destructive on source. ALL positionals → `writes` (both source and destination paths change state: source disappears, destination appears). `reads: []`. With `-t DIR`: `-t` value + remaining positionals all → `writes`. This deliberately diverges from `cp`: a `Write($WORKSPACE/**)` rule must catch moves *out of* the workspace, which requires the source in `writes`.
- **`chmod`** — first positional is mode (not a path); remaining positionals → `writes` (permission change is a metadata write).
- **`chown`** — first positional is owner spec; remaining positionals → `writes`.
- **`curl`** — every URL positional → `network: { kind: "http", target: URL }`. With `-o FILE`: file → `writes`. With `-O`: `writes: []`. With `-d @file`: `file` → `reads`; inline `-d 'key=val'` does not. **`incomplete: true` whenever `-L` (follow redirects) is present** — the eventual egress host can differ from the argv URL, so `network.target` is only the *initial* destination. Without `-L`, `curl` does not follow redirects (the HTTP response surfaces the redirect to the caller); `network.target` is authoritative for the connection actually made. `-O` also sets `incomplete: true` — basename derived by curl from the URL (and may change under server response).
- **`wget`** — every URL positional → `network: { kind: "http", target: URL }`. With `-O FILE`: file → `writes`. Without `-O`: `writes: []`. **`incomplete: true` always** — wget follows redirects by default (up to `--max-redirect`, default 20), so `network.target` is only the *initial* destination; the eventual egress host can differ. Additionally, without `-O` the written basename is derived from the URL/response by wget itself. Consumers MUST require a `Run(wget)` rule on top of any argv-aware `Network(host)` / `Write(path)` rule.
- **`tar`** — `-c` create: `-f FILE` → `writes`; positional file list → `reads`. `-t` list: `-f FILE` → `reads`; no writes. `-x` extract: `-f FILE` → `reads` (the archive itself); `writes: []` AND **`incomplete: true`** — extraction destinations are inside the archive, cannot be derived from argv, and may escape any `-C DIR` via absolute paths or `..` traversal. `incomplete` machine-signals consumers to refuse argv-only `Write(path)` enforcement and require a `Run(tar -x)` rule.
- **`scp`** — for each `host:path` endpoint: `network: { kind: "ssh", target: host }`; the local-side path → `reads` (if source) or `writes` (if dest). With `-i KEY`: KEY value → `reads`. Trust-boundary flags (`-o`, `-F`, `-J`) → `null`: each can rewrite the effective endpoint or pull in arbitrary local I/O (via `ProxyCommand`, `IdentityFile`, `Include`, etc.) and there is no safe way to model that with argv alone. **`incomplete: true`** for all parseable cases — the literal argv host MAY still be a `Host` alias from the *default* `~/.ssh/config` resolving elsewhere; default-path identity files / `known_hosts` / `Include`-pulled paths not reported. Consumers MUST require a `Run(scp)` rule on top of any argv-aware `Network(host)` / `Read(path)` rule.
- **`ssh`** — `network: { kind: "ssh", target: host }`; no writes; remote command not interpreted. With `-i KEY`: KEY value → `reads`. Trust-boundary flags → `null`: `-o` (arbitrary `ssh_config` keys, including `ProxyCommand`, `LocalCommand`, `ProxyJump`, `IdentityFile`), `-F config` (alt config rewrites everything), `-J jump` (jump-host redirect), `-D port` / `-L spec` / `-R spec` (port forwards add unreported network/local-listen surface). **`incomplete: true`** for all parseable cases — the literal argv host MAY still be a `Host` alias from the *default* `~/.ssh/config`; default identity files, `known_hosts`, and `Include`-pulled paths not reported. Consumers MUST require a `Run(ssh)` rule on top of any argv-aware `Network(host)` / `Read(path)` rule.

## Testing strategy

- **Per-spec test file**: ≥ one positive case per recognized flag, one
  ambiguous case → `null`, one bundled-flags case (`-rf`), one `--`
  end-of-options case. For specs that can return `incomplete: true`
  (`tar -x`, `ssh`, `scp`, all `wget`, `curl -L`, `curl -O`): one
  assertion that the flag is set; one assertion that complete cases
  (e.g., `curl -o foo URL` without `-L`) do NOT set it.
- **SSH/SCP trust-boundary tests**: explicit negative cases that prove
  fail-closed behavior — `ssh -o ProxyCommand="nc evil 22" host`,
  `ssh -o LocalCommand="rm -rf /" host`, `ssh -F /tmp/cfg host`,
  `ssh -J jump host`, `ssh -L 8080:internal:80 host`,
  `scp -o IdentityFile=/etc/passwd src host:dst` all return `null`.
- **Registry test**: `BUILTIN_SPECS.size === 10` with exact name set
  `["rm","cp","mv","chmod","chown","curl","wget","tar","scp","ssh"]`;
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
