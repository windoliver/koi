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

### Soundness contract — required reading before consuming `SpecResult`

The discriminated `SpecResult` union encodes the trust level of each
spec call. The required consumer policy per kind:

| `kind` | Argv-aware rules (`Read`/`Write`/`Network`) | `Run(...)` rules |
|---|---|---|
| `complete` | use `semantics` freely | optional; prefix or exact, consumer's choice |
| `partial` | use `semantics` only paired with an exact-argv `Run(...)` co-rule | **must be exact-argv-match only** for this argv |
| `refused` | MUST NOT use; no semantics produced | **must be exact-argv-match only** for this argv |

**Universal exact-argv `Run(...)` guard.** Bash rule matchers in this
repo accept argv-prefix rules. A broad allow like `Run(curl)`,
`Run(ssh prod)`, or `Run(cp)` would otherwise re-authorize forms the
spec marked `partial` or `refused`, defeating their fail-closed
intent. The follow-up consumer wiring MUST reject or promote
prefix-shaped `Run(...)` rules whenever any argv they would match
yields `kind: "partial" | "refused"` — typically by per-argv
re-classification at evaluation time, or by a distinct exact-only
rule shape at config-load. This guard is consumer-side; the spec
cannot enforce it alone, and any consumer that ignores it has an
authorization bypass.

**`partial` is triggered by:** under-modeled but argv-derivable forms
where the populated fields are still useful but incomplete. Examples
(carried in `reason`):
  - `tar -x` — extraction targets inside the archive (`reason: "tar-extract-targets-in-archive"`).
  - `cp`/`mv` without `-T` (and without `-t`) — destination may be a directory (`reason: "cp-mv-dest-may-be-directory"`).
  - `wget` always (`reason: "wget-follows-redirects"`); `curl -L` (`reason: "curl-follows-redirects"`); `curl -O` (`reason: "curl-O-derived-basename"`).
  - **Recursive forms** (`rm -r`, `cp -r`, `chmod -R`, `chown -R`) — reported paths are subtree *roots*; descendants are not enumerated (`reason: "recursive-subtree-root"`). Consumer rule: a path-based rule that allows or denies a subtree root applies transitively to every descendant.

(Note: `ssh`/`scp` are always `refused` in this PR — see semantics
section. Plain `ssh host` cannot be safely modeled as `partial`
because default `~/.ssh/config` can inject `ProxyCommand`,
`LocalCommand`, `IdentityFile`, or `Include`-driven I/O without any
flag on argv.)

**`refused` is triggered by:**
  - `cause: "parse-error"` — unparseable flag positions, missing
    required positionals, mutually-exclusive mode flags in conflict,
    or unknown flags whose value-consumption is unknown.
  - `cause: "unsupported-form"` — syntactically-valid invocations the
    spec deliberately refuses because reporting partial semantics
    would be misleading. Examples: `curl` with an unknown URL scheme,
    `wget` with a non-http/ftp scheme, `ssh` with a trailing remote
    command, `ssh`/`scp` with trust-boundary flags (`-o`, `-F`, `-J`,
    port forwards).

`cause` is consumer-observable so audit logs can distinguish
"caller typo" from "caller did something the spec rejects on purpose"
without re-implementing per-command parsers.

**Orthogonal concern — path canonicalization.** `kind: "complete"`
means **argv-complete**: every I/O effect of the command is reflected
in the populated fields, and the strings come verbatim from argv. It
does NOT mean the strings are canonical, symlink-resolved, or absolute.
Symlinks under an allowed path can resolve outside the policy boundary;
relative paths interact with cwd; `~` is not expanded. Consumers MUST
canonicalize and symlink-resolve every `reads`/`writes` entry before
applying any path-based rule. This applies to all three kinds and
would apply equally if the spec did filesystem resolution itself.

This PR ships **specs only — exported but unconsumed**. No existing
package calls `createSpecRegistry`, `BUILTIN_SPECS`, or any individual
`spec*` function as of this PR. The fail-closed contract (exact-argv
`Run(...)` for partial/refused argv) is therefore **not at risk in this
PR** — there is no consumer that could be re-authorized by prefix
rules — but the same property means the security value of the specs is
not realized until the consumer lands.

The **follow-up consumer PR** is required to bundle three things in a
single change: (a) a consumer that calls into specs (e.g.,
`@koi/security/middleware-permissions`), (b) the rule-evaluator change
that promotes/rejects prefix `Run(...)` rules whenever any matched
argv yields `kind: "partial" | "refused"`, and (c) the golden query
that proves the end-to-end deny path. Splitting (a) from (b) would
open a fail-open window — operators would believe `partial`/`refused`
are protective while existing prefix rules continue to allow the
underlying invocations. The follow-up issue MUST state this bundling
requirement explicitly.

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
- ssh remote-command recursion — `ssh` always returns `kind: "refused"`
  in this PR (every form: plain, flag, remote-command, trust-boundary);
  see `ssh` semantics below for the rationale and how `detail`
  discriminates.

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
}

export interface NetworkAccess {
  readonly kind: "http" | "ssh" | "ftp";
  /** Raw argv string — full URL for curl/wget, hostname for ssh/scp. */
  readonly target: string;
  /**
   * Extracted host for `Network(host)` rule matching. For ssh/scp
   * this equals `target`. For curl/wget the spec parses the URL and
   * stores `URL.host` here (host:port if non-default port; hostname
   * otherwise). If URL parsing fails, the spec returns
   * `kind: "refused", cause: "parse-error"` rather than emitting a
   * `NetworkAccess` with an unparseable host.
   */
  readonly host: string;
}

/**
 * Discriminated union returned by every spec. Three states with
 * machine-distinguishable meanings — see Soundness contract for the
 * consumer policy each requires.
 */
export type SpecResult =
  /**
   * `kind: "complete"` — argv-derived I/O accounting is complete.
   * Consumers MAY use `semantics` as the sole input to argv-aware
   * `Read(path)` / `Write(path)` / `Network(host)` rules. A `Run(...)`
   * co-rule is optional. (Path canonicalization remains a separate
   * consumer concern.)
   */
  | { readonly kind: "complete"; readonly semantics: CommandSemantics }
  /**
   * `kind: "partial"` — argv-derivable facts are reported in
   * `semantics`, but at least one I/O effect cannot be resolved from
   * argv alone. `reason` names the gap (e.g., "redirect-following",
   * "destination-may-be-directory", "ssh-config-alias"). Consumers
   * MUST require an **exact-argv** `Run(...)` co-rule for this argv
   * — prefix `Run(...)` rules MUST be promoted to exact-match or
   * rejected at config-load. Argv-aware rules MAY use `semantics`,
   * but only in conjunction with the exact-argv co-rule.
   */
  | { readonly kind: "partial"; readonly semantics: CommandSemantics; readonly reason: string }
  /**
   * `kind: "refused"` — the spec produces no semantics for this
   * argv. `cause` distinguishes structural parse failure from a
   * deliberately-unsupported syntactically-valid form so the
   * consumer can audit/log appropriately. Consumers MUST NOT feed
   * this argv into any argv-aware rule and MUST require an
   * **exact-argv** `Run(...)` rule for it (no prefix matching);
   * any `Run(...)` rule whose pattern would also match this argv
   * via prefix MUST be rejected at config-load.
   */
  | {
      readonly kind: "refused";
      readonly cause: "parse-error" | "unsupported-form";
      readonly detail: string;
    };

export type CommandSpec = (argv: readonly string[]) => SpecResult;

// registry.ts
export const BUILTIN_SPECS: ReadonlyMap<string, CommandSpec>;
export function createSpecRegistry(): Map<string, CommandSpec>;
export function registerSpec(
  reg: Map<string, CommandSpec>,
  name: string,
  fn: CommandSpec,
): void;

// per-command files — direct named exports for tree-shaking + tests
export function specRm(argv: readonly string[]): SpecResult;
export function specCp(argv: readonly string[]): SpecResult;
export function specMv(argv: readonly string[]): SpecResult;
export function specChmod(argv: readonly string[]): SpecResult;
export function specChown(argv: readonly string[]): SpecResult;
export function specCurl(argv: readonly string[]): SpecResult;
export function specWget(argv: readonly string[]): SpecResult;
export function specTar(argv: readonly string[]): SpecResult;
export function specScp(argv: readonly string[]): SpecResult;
export function specSsh(argv: readonly string[]): SpecResult;
```

### Design decisions (questions resolved during brainstorming)

| # | Decision | Rationale |
|---|----------|-----------|
| Q1 | **Hybrid factory + named exports.** Exported `BUILTIN_SPECS: ReadonlyMap`, `createSpecRegistry()` returns fresh `Map` seeded with builtins, `registerSpec()` is a thin one-line helper. No class wrapper. | Matches current Koi main idiom (`createDefaultManifestRegistry`, `createMcpResolver`). No module-level mutable state. CLAUDE.md: "Use `class` only when state encapsulation is genuinely needed" — `Map` is the registry. |
| Q2 | **Verbatim argv strings in `reads`/`writes`/`network.target`.** No path normalization, no FS access, no glob expansion. Caller resolves relative→absolute against its own cwd. Specs MUST NOT invent fake-path sentinels (`"."`) or hard-coded conventional paths to stand in for unknown I/O; refuse the analysis with `kind: "refused"` instead. (Exception: `NetworkAccess.host` is parsed from `target` for URL-bearing commands — pure URL parsing, no FS/network access.) | Walker output is already static (no `$VAR`, no `$(…)`). Spec stays trivially pure. Fake sentinels would conflate "wrote a file inside cwd" with "wrote the directory entry `.`" and mislead `Write(path)` rule evaluators. Hard-coded paths (e.g., `~/.ssh/*`) are unsound — they over-report (paths not actually touched) and under-report (config-driven alternates). |
| Q3 | **Strict allowlist per command for flag *parsing*; under-approximate I/O reporting tagged via `SpecResult.kind`.** Each spec carries a curated set of recognized flags. Unknown flag → `kind: "refused", cause: "parse-error"` (we cannot tell whether it consumes the next argv). When parsing succeeds but downstream effects can't be argv-derived, return `kind: "partial"` with a `reason`; when the form is intentionally unsupported, return `kind: "refused", cause: "unsupported-form"`. | Issue criterion "never guess" applies to argv-shape parsing — guessing positional alignment under unknown flags is unsafe. The discriminated `SpecResult` lets the spec preserve argv facts in `partial` cases (URLs, hosts, literal paths) without misleading consumers about completeness. |
| Q4 | **Keep `envMutations` field; always `[]` for current 9.** | Matches issue contract. Documents "this command does NOT mutate env" rather than leaving implicit. Future-proofs for an `export`/`unset` spec without a breaking type change. |
| Q5 | **Skip golden query in this PR.** | New code is pure library helpers — no model call, no tool, no agent-observable side effect. Golden query lands with the consumer in a follow-up PR. |

## Per-command flag allowlists

| Command | Recognized flags | Returns `kind: "refused"` on |
|---|---|---|
| `rm` | `-r`/`-R`, `-f`, `-i`, `-d`, `-v`, `--` | unknown flag, missing positional |
| `cp` | `-r`/`-R`, `-f`, `-i`, `-p`, `-a`, `-v`, `-t DIR`, `-T`, `--` | unknown flag, missing source/dest |
| `mv` | `-f`, `-i`, `-n`, `-v`, `-t DIR`, `-T`, `--` | unknown flag, missing source/dest |
| `chmod` | `-R`, `-v`, `-f`, `--` + mode + path | unknown flag, missing mode or path |
| `chown` | `-R`, `-v`, `-f`, `--` + owner + path | unknown flag, missing owner or path |
| `curl` | `-o`/`--output FILE`, `-O`, `-L`, `-X METHOD`, `-d`/`--data`, `-H`, `-s`, `-i`, URL(s) | `--config`/`-K`, `--next`, `-T`, unknown flag |
| `wget` | `-O FILE`, `-q`, `-c`, `-N`, URL(s) | `-i`/`--input-file`, unknown flag |
| `tar` | `-x`/`-c`/`-t` (exactly one); `-f FILE`, `-z`/`-j`, `-C DIR`, `-v`, `--`, file list | mutually-exclusive mode flags, unknown flag, no `-f` (stdin) |
| `scp` | n/a — always `refused` (default ssh_config exposure) | every argv; `detail` discriminates plain vs flag vs trust-boundary |
| `ssh` | n/a — always `refused` (default ssh_config exposure) | every argv; `detail` discriminates plain vs flag vs remote-command vs trust-boundary |

Long flags accept both `--output FILE` and `--output=FILE`. Bundled short
flags (`-rf` → `-r -f`) are split by `parse-flags.ts`.

## Spec semantics — per command

In every spec below, "returns X" is shorthand for "returns `{ kind: ..., semantics: { ... } }`" or "returns `{ kind: "refused", cause, detail }`". The `kind` for each form is called out explicitly.

**Recursive forms — universal rule.** Whenever a recognized recursive flag is present (`rm -r`/`-R`, `cp -r`/`-R`/`-a`, `chmod -R`, `chown -R`), the spec returns `kind: "partial", reason: "recursive-subtree-root"`. The reported `writes`/`reads` paths are subtree *roots*, not the full descendant set; argv alone cannot enumerate descendants without FS access. Consumers MUST treat each subtree-root path as covering the entire subtree under it (e.g., a `Write($WORKSPACE/**)` rule is satisfied iff the subtree root is inside `$WORKSPACE`, since every descendant inherits that property), AND require a `Run(...)` co-rule. The per-command sections below note "if recursive: partial" rather than restating this rule.

- **`rm`** — `complete` for non-recursive forms: all positional paths → `writes`. With `-r`/`-R`/`-d` (recursive/directory): `partial`, `reason: "recursive-subtree-root"`, same `writes`. No reads, no network, no env.
- **`cp`** — Forms in precision order. **If `-r`/`-R`/`-a` is present, the result is `partial` with `reason: "recursive-subtree-root"` regardless of which form below applies** (the form determines `reads`/`writes` paths; the recursive flag determines `kind`/`reason`).
  - With `-T` (two positionals): `complete` (or `partial` if recursive), `reads: [src], writes: [dst]`.
  - With `-t DIR` (one or more srcs): `complete` (or `partial` if recursive), `reads: [...srcs], writes: ["DIR/<basename(src)>" for each src]`. Basename uses POSIX semantics — strip trailing `/` from src, then take the segment after the last `/`. If any src is `/` or normalizes to empty after stripping, the whole call returns `kind: "refused", cause: "parse-error", detail: "unable to derive basename for src '<src>'"` rather than emitting a malformed write path. (The check is per-src and pure — no FS access.)
  - Without `-t` or `-T` (`cp [-r] src... dst`): `partial`, `reason: "cp-mv-dest-may-be-directory"` (or both reasons joined by `;` if also recursive), `reads: [...srcs]`, `writes: [dst, ...("dst/<basename(src)>" for each src)]`. Both possibilities are emitted (over-approximation): if `dst` is a file, only `dst` is written; if `dst` is a directory, only the derived child paths are written. Over-approximating `writes` is the safer fail-closed choice — a `Write($WORKSPACE/**)` deny rule will trigger on whichever real path applies.
- **`mv`** — destructive on source. Forms in precision order (src always included in `writes` so a `Write($WORKSPACE/**)` rule catches moves *out of* the workspace):
  - With `-T` (two positionals): `complete`, `writes: [src, dst], reads: []`.
  - With `-t DIR`: `complete`, `writes: [...srcs, ...("DIR/<basename(src)>" for each src)], reads: []`. Basename derivation follows the same POSIX-stripping rule as `cp`; any src that fails to derive a basename causes the spec to return `kind: "refused", cause: "parse-error"`.
  - Without `-t` or `-T` (`mv src... dst`): `partial`, `reason: "cp-mv-dest-may-be-directory"`, `writes: [...srcs, dst, ...("dst/<basename(src)>" for each src)], reads: []` (over-approximation).
- **`chmod`** — `complete` for non-recursive forms. First positional is mode (not a path); remaining positionals → `writes` (permission change is a metadata write). With `-R`: `partial`, `reason: "recursive-subtree-root"`, same `writes`.
- **`chown`** — `complete` for non-recursive forms. First positional is owner spec; remaining positionals → `writes`. With `-R`: `partial`, `reason: "recursive-subtree-root"`, same `writes`.
- **`curl`** — each URL positional is parsed with the platform `URL`
  constructor and dispatched by `URL.protocol`:
  - `http:`, `https:` → `network: { kind: "http", target: rawURL, host: URL.host }`
  - `ftp:`, `ftps:` → `network: { kind: "ftp", target: rawURL, host: URL.host }`
  - `scp:`, `sftp:` → `kind: "refused", cause: "unsupported-form", detail: "<scheme>: crosses SSH trust boundary; same default ssh_config exposure as ssh/scp commands"`. Consistent with the always-refused policy for `ssh`/`scp`: SSH-backed transfers can pull in `~/.ssh/config`, `IdentityFile`, `known_hosts`, etc. without any flag on argv.
  - `file:` → only the form `file:///<absolute-path>` (empty authority) is accepted; emit `reads: [URL.pathname]` and no `network`. Any `file:` URL with a non-empty authority (`file://host/path`, `file://path` — ambiguous, may be host or path) returns `kind: "refused", cause: "unsupported-form", detail: "file:// with non-empty authority is ambiguous; use file:///<path>"`.
  - URL parse failure → `kind: "refused", cause: "parse-error", detail: "<URL constructor error>"`.
  - Any other scheme → `kind: "refused", cause: "unsupported-form", detail: "unsupported URL scheme: <scheme>"`.

  With `-o FILE`: file → `writes`. With `-O`: `writes: []`. With `-d @file`: `file` → `reads`; inline `-d 'key=val'` does not. **Result `kind`:** `partial` with `reason: "curl-follows-redirects"` if `-L` is present; `partial` with `reason: "curl-O-derived-basename"` if `-O` is present; otherwise `complete`. (If both apply, `reason` lists both, joined by `;`.)
- **`wget`** — each URL positional is parsed with `URL` and dispatched by `URL.protocol`:
  - `http:`, `https:` → `network: { kind: "http", target: rawURL, host: URL.host }`
  - `ftp:`, `ftps:` → `network: { kind: "ftp", target: rawURL, host: URL.host }`
  - URL parse failure → `kind: "refused", cause: "parse-error"`.
  - Any other scheme → `kind: "refused", cause: "unsupported-form", detail: "unsupported URL scheme: <scheme>"`.

  With `-O FILE`: file → `writes`. Without `-O`: `writes: []`. **Always `partial`, `reason: "wget-follows-redirects"`** — wget follows redirects by default (up to `--max-redirect`, default 20), so `network.target` is only the *initial* destination; without `-O` the basename is also URL-derived.
- **`tar`** — `-c` create: `complete`, `-f FILE` → `writes`; positional file list → `reads`. `-t` list: `complete`, `-f FILE` → `reads`; no writes. `-x` extract: `partial`, `reason: "tar-extract-targets-in-archive"`, `-f FILE` → `reads` (the archive itself); `writes: []` (extraction targets inside the archive may escape any `-C DIR` via absolute paths or `..` traversal).
- **`scp`** — **Always `refused`, `cause: "unsupported-form"`.** Even with no flags, the default `~/.ssh/config` can inject `ProxyCommand` (arbitrary local execution), `LocalCommand`, `IdentityFile` (alt key reads), `Include` (alt config reads), and `Host` aliases that rewrite the endpoint. Argv alone cannot disambiguate "this scp connects exactly where it appears to" from "this scp triggers arbitrary local I/O via default config". Reporting `partial` semantics would let those facts participate in authorization in a way the contract cannot defend. `detail` carries the offending flag when one is present (e.g., `-o`, `-F`, `-J`); for plain forms it carries `"plain scp may invoke ProxyCommand/Include/IdentityFile via default ssh_config"`. Consumer must use exact-argv `Run(scp ...)` rules.
- **`ssh`** — **Always `refused`, `cause: "unsupported-form"`.** Same default-config exposure as `scp`: even plain `ssh host` can resolve to `ProxyCommand`/`LocalCommand`/`IdentityFile`/`Include`-driven I/O via the default `~/.ssh/config`, and the literal argv host may be a `Host` alias rewriting the endpoint. `detail` discriminates: trust-boundary flag present → `"<flag> can rewrite endpoint, add port-forward surface, or trigger arbitrary local execution"`; trailing remote command → `"ssh remote command requires exact-argv Run rule"`; plain form → `"plain ssh may invoke ProxyCommand/Include/IdentityFile via default ssh_config"`. Consumer must use exact-argv `Run(ssh ...)` rules.

## Testing strategy

- **Per-spec test file**: ≥ one positive case per recognized flag, one
  parse-failure case → `kind: "refused", cause: "parse-error"`, one
  bundled-flags case (`-rf`), one `--` end-of-options case. For specs
  that can return `kind: "partial"` (`tar -x`, all `wget`, `curl -L`,
  `curl -O`, `cp`/`mv` without `-T` and without `-t`, `rm`/`cp`/`chmod`/`chown`
  with recursive flag): one assertion that `kind === "partial"` and
  `reason` matches the documented string; one assertion that
  fully-complete cases (`cp -T`, `cp -t DIR`, `curl -o foo URL` without
  `-L`, `chmod 755 file` without `-R`) return `kind === "complete"`.
- **Recursive subtree tests**: `rm -r dir` returns `kind: "partial"`,
  `reason: "recursive-subtree-root"`, `writes: ["dir"]`. Same for
  `cp -r src dst`, `chmod -R 755 dir`, `chown -R u dir`. The
  recursive flag is the discriminator; non-recursive variants of
  the same commands return `kind: "complete"`.
- **SSH/SCP always-refused tests**: every form of ssh and scp returns
  `kind: "refused", cause: "unsupported-form"`, with `detail`
  discriminating the case:
  - plain forms (`ssh host`, `scp src host:dst`) → detail mentions
    "default ssh_config" exposure;
  - trust-boundary flag forms (`ssh -o ProxyCommand=…`, `-F`, `-J`,
    `-L`, etc.) → detail names the flag;
  - ssh remote-command forms (`ssh host "rm -rf /"`) → detail mentions
    "remote command requires exact-argv Run rule".

  Add an explicit assertion that NO ssh/scp argv ever returns
  `kind: "complete"` or `kind: "partial"` in this PR.
- **cp/mv kind + path-derivation tests**:
  - `cp -T src dst` → `kind: "complete"`, `writes === ["dst"]`.
  - `cp -t out a b` → `kind: "complete"`, `writes === ["out/a", "out/b"]`
    (verifies basename derivation works).
  - `cp -t out src/` → `kind: "complete"`, `writes === ["out/src"]`
    (verifies trailing-slash POSIX strip).
  - `cp -t out /` → `kind: "refused", cause: "parse-error"`
    (verifies basename derivation refusal).
  - `cp foo.txt out/dir` → `kind: "partial"`,
    `reason === "cp-mv-dest-may-be-directory"`,
    `writes === ["out/dir", "out/dir/foo.txt"]` (over-approximation
    contains both possibilities).
  - Mirror set for `mv`, with src always present in `writes`.
- **URL-scheme tests** (curl/wget): `curl file:///etc/passwd` returns
  `kind: "complete"` with `reads: ["/etc/passwd"]` and no `network`.
  `curl file://host/path` and `curl file://path` both return
  `kind: "refused", cause: "unsupported-form"` (ambiguous authority).
  `curl ftp://host/file` returns `network.kind === "ftp"`;
  `curl gopher://host/` returns `kind: "refused", cause: "unsupported-form"`;
  `curl http://[invalid` returns `kind: "refused", cause: "parse-error"`.
  Non-http/ftp for wget returns the same refused shape.
- **NetworkAccess.host extraction**: `curl https://example.com/path`
  produces `network[0].host === "example.com"`;
  `curl https://example.com:8443/path` produces
  `network[0].host === "example.com:8443"`. Malformed URL
  (e.g., `curl http://[invalid`) returns
  `kind: "refused", cause: "parse-error"`.
  (No ssh/scp host-extraction test — those always refuse.)
- **Registry test**: `BUILTIN_SPECS.size === 10` with exact name set
  `["rm","cp","mv","chmod","chown","curl","wget","tar","scp","ssh"]`;
  `createSpecRegistry()` returns mutable `Map` containing all builtins;
  `registerSpec()` adds entries; existing builtins remain after register.
- **`parse-flags.test.ts`**: invariants on the shared helper —
  bundling, value-flag termination, unknown-flag rejection, `--` cutoff.
- Coverage threshold remains 80% (CLAUDE.md / `bunfig.toml`).
- Test naming: behavior-style ("returns refused parse-error when -t has
  no value"), not "test case 1".

## Docs

`docs/L2/bash-ast.md` gains a new section, **"Per-command semantics"**,
covering:

- Public API (types, registry, named spec exports).
- The nine commands + their flag allowlists (table above).
- The `SpecResult` discriminated union (complete / partial / refused),
  exact-argv `Run(...)` guard for partial/refused, and why callers
  must fail closed.
- An explicit note: consumer wiring + golden query land in a follow-up
  PR; pointer to the new tracking issue.

## Follow-up tracking issue

Title: **`@koi/security/middleware-permissions`: consume bash-ast specs for write/read/network rules**

Body sketch:

- References #1662 (this PR) and the soon-to-merge specs commit.
- **Mandatory bundling.** Land all three of (a) consumer wiring,
  (b) exact-argv `Run(...)` enforcement for any argv that yields
  `kind: "partial" | "refused"`, (c) golden query proving the deny
  path. Splitting these creates a fail-open window. PR description
  MUST link this design doc and call out the bundle.
- Scope: extend `@koi/security/permissions` rule schema with
  `Write(path)`, `Read(path)`, `Network(host)` shapes;
  update `rule-evaluator.ts` to gate prefix `Run(...)` against
  per-argv spec results; wire bash-aware path inside
  `middleware-permissions/middleware.ts` (or split that file first).
- **Critical consumer guard** — for **every argv where the spec
  returns `kind: "partial" | "refused"`**, `Run(...)` rules MUST be
  exact-argv-only for that argv. Prefix-shaped rules either get
  promoted to exact match or rejected at config-load. Without this,
  broad allow-rules (`Run(curl)`, `Run(ssh prod)`, `Run(scp host)`)
  would re-authorize the under-modeled or refused forms the spec
  deliberately marked non-authoritative (unknown URL schemes, ssh
  remote commands, ssh/scp trust-boundary flags, redirect-following
  HTTP, destination-may-be-directory cp/mv, etc.). The guard MUST
  have explicit consumer-side tests proving prefix `Run(...)` rules
  are rejected/promoted for these forms.
- **Network(host) host extraction** — `NetworkAccess.target` is raw
  argv. For `curl`/`wget` it is a full URL; the spec parses `URL.host`
  into the structured `host` field. The consumer's `Network(host)`
  evaluator MUST use `NetworkAccess.host`, NOT compare rule values
  directly against `target`. Tests MUST prove `Network(example.com)`
  matches `curl https://example.com/path`. (Note: `ssh`/`scp` do not
  emit `NetworkAccess` in this PR — they always refuse — so
  `Network(host)` does not apply to them; consumers must use
  exact-argv `Run(ssh ...)` / `Run(scp ...)` rules. A future PR that
  models default ssh_config can revisit this.)
- Acceptance: golden query (`Bash(rm -rf ./tmp)` → spec → permission deny
  → trajectory reflects deny) wired into `@koi/runtime`.
- Risk note: `middleware-permissions/middleware.ts` is currently 2398
  lines (well past the 800 hard max); consumer wiring should refactor
  into smaller files first.

## Acceptance checklist (recap from issue)

- [ ] One spec file per target command, each < 80 lines.
- [ ] `spec*(argv)` returns `kind: "refused"` (cause: `parse-error` or
      `unsupported-form`) on ambiguous/unsupported argv (never guess).
- [ ] Unit tests per spec covering flag variants, positional args, ambiguous cases.
- [ ] `registerSpec(name, fn)` exposed from `@koi/bash-ast`.
- [ ] `docs/L2/bash-ast.md` updated.
- [ ] CI green: `bun run test`, `typecheck`, `lint`, `check:layers`,
      `check:unused`, `check:duplicates`.
- [ ] Follow-up tracking issue opened for consumer + golden query.
