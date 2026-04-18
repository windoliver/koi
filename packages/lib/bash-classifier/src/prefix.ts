/**
 * `prefix(tokens)` — canonical permission key from a tokenized command.
 *
 * Pre-normalizes before ARITY lookup to close common bypasses:
 *   - Strips leading `VAR=value` env-variable assignments
 *   - Strips a leading `env [VAR=val ...]` or similar wrapper
 *   - Strips leading `command`, `builtin`, `exec`, `nohup`, `time`
 *   - Strips `timeout <n>` and `stdbuf -oL -eL` with their argument form
 *   - Basenames a leading absolute/relative path (`/usr/bin/sudo` → `sudo`)
 *
 * After normalization, uses the longest `ARITY` key that is a leading
 * prefix. Falls back to arity 1 (binary name alone) when no key matches.
 *
 * Not normalized (documented caveats — callers should combine with the
 * `DANGEROUS_PATTERNS` structural regex for full coverage):
 *   - Per-command global options like `git -c key=value push` or
 *     `docker --context=x compose up` (would require per-command flag maps)
 *   - Commands inside `bash -c "..."` or similar interpreters (use the
 *     `shell-dash-c` / `eval` patterns in `DANGEROUS_PATTERNS`)
 *
 * Pure function. No regex except the VAR=value test. No side effects.
 */

import { ARITY } from "./arity.js";

/**
 * Internal sentinel emitted by `normalize` when a fail-closed
 * condition is detected (e.g. flagged `command`/`exec`/`nohup`
 * wrappers we cannot safely peel). `prefix` remaps it to
 * `UNSAFE_PREFIX` before returning.
 */
const UNSAFE_SENTINEL_TOKEN = "\0!complex";

/** Per-wrapper option grammar. Unknown flags fail closed. */
interface WrapperSpec {
  readonly argFlags: ReadonlySet<string>; // flag + next token
  readonly boolFlags: ReadonlySet<string>; // flag only
}

const WRAPPER_SPECS: Readonly<Record<string, WrapperSpec>> = {
  env: {
    // `-S` / `--split-string` is intentionally EXCLUDED from argFlags:
    // it evaluates its argument as a shell script string, not a plain
    // command path. Peeling it the way we peel `-u VAR` would drop the
    // whole payload and let canonicalPrefix fall back to a too-coarse
    // prefix. Instead we detect it separately and route to
    // `!complex` so the middleware prompts per-command.
    argFlags: new Set(["-u", "--unset", "-C", "--chdir"]),
    boolFlags: new Set(["-i", "--ignore-environment", "-0", "--null", "--help", "--version"]),
  },
  nice: {
    argFlags: new Set(["-n", "--adjustment"]),
    boolFlags: new Set(["--help", "--version"]),
  },
  ionice: {
    argFlags: new Set([
      "-c",
      "-n",
      "-p",
      "-P",
      "-u",
      "--class",
      "--classdata",
      "--pid",
      "--pgid",
      "--uid",
    ]),
    boolFlags: new Set(["-t", "--ignore", "-h", "--help", "--version"]),
  },
  stdbuf: {
    argFlags: new Set(["-i", "-o", "-e", "--input", "--output", "--error"]),
    boolFlags: new Set(["--help", "--version"]),
  },
  timeout: {
    argFlags: new Set(["-k", "-s", "--kill-after", "--signal"]),
    boolFlags: new Set([
      "-f",
      "--foreground",
      "--preserve-status",
      "-v",
      "--verbose",
      "--help",
      "--version",
    ]),
  },
  time: {
    argFlags: new Set(["-o", "-f", "--format", "--output", "--log-file"]),
    boolFlags: new Set([
      "-p",
      "-v",
      "-q",
      "-a",
      "--portability",
      "--verbose",
      "--quiet",
      "--append",
    ]),
  },
};

/**
 * Wrappers without structured options (or with trivial ones). We peel the
 * wrapper itself but refuse to skip any flag: a leading flag after one of
 * these typically indicates a form we haven't modeled, so we fail closed.
 */
const FLAGLESS_WRAPPERS: ReadonlySet<string> = new Set(["command", "builtin", "exec", "nohup"]);

/**
 * Per-command pre-subcommand options for high-value CLIs. Without
 * these, a form like `git -c key=value push` produces prefix
 * `git -c` and bypasses deny rules on `bash:git push*`. After peeling
 * these known options, the real subcommand (`push`) surfaces and the
 * ARITY lookup produces the correct permission key.
 */
const COMMAND_PRE_OPTIONS: Readonly<Record<string, WrapperSpec>> = {
  git: {
    argFlags: new Set([
      "-c",
      "-C",
      "--git-dir",
      "--work-tree",
      "--exec-path",
      "--namespace",
      "--config-env",
      "--super-prefix",
      "--list-cmds",
    ]),
    boolFlags: new Set([
      "--version",
      "--help",
      "--no-pager",
      "--bare",
      "--html-path",
      "--man-path",
      "--info-path",
      "--paginate",
      "-p",
      "--no-replace-objects",
      "--no-optional-locks",
    ]),
  },
  docker: {
    argFlags: new Set([
      "--context",
      "--host",
      "-H",
      "--config",
      "--log-level",
      "-l",
      "--tlscacert",
      "--tlscert",
      "--tlskey",
    ]),
    boolFlags: new Set(["--debug", "-D", "--tls", "--tlsverify", "--help", "--version", "-v"]),
  },
  kubectl: {
    argFlags: new Set([
      "--namespace",
      "-n",
      "--context",
      "--kubeconfig",
      "--cluster",
      "--user",
      "--server",
      "-s",
      "--token",
      "--as",
      "--as-group",
      "--log-file",
      "-v",
    ]),
    boolFlags: new Set(["--help", "-h", "--insecure-skip-tls-verify", "--disable-compression"]),
  },
  helm: {
    argFlags: new Set([
      "--namespace",
      "-n",
      "--kubeconfig",
      "--kube-context",
      "--registry-config",
      "--repository-cache",
      "--repository-config",
    ]),
    boolFlags: new Set(["--help", "--debug", "--version"]),
  },
  npm: {
    // npm's `--prefix PATH`, `--userconfig FILE`, etc. come before the subcommand.
    argFlags: new Set(["--prefix", "--userconfig", "--globalconfig", "--registry", "-C"]),
    boolFlags: new Set(["--help", "--version", "-v", "--silent", "-g", "--global"]),
  },
};

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * System bin directories whose contents are trusted to be the canonical
 * binary. `/usr/bin/git` is treated as equivalent to a PATH-resolved
 * `git`; any other path (`./git`, `/tmp/git`, `~/bin/git`, user-writable
 * dirs) is kept path-qualified so a dropped malicious binary cannot
 * silently inherit a rule meant for the system binary.
 */
const TRUSTED_BIN_PREFIXES: readonly string[] = [
  "/usr/bin/",
  "/usr/local/bin/",
  "/usr/sbin/",
  "/bin/",
  "/sbin/",
  "/opt/homebrew/bin/",
  "/opt/homebrew/sbin/",
  "/opt/local/bin/",
];

/** Unconditional basename (used for shell-interpreter detection only). */
function basenameLoose(t: string): string {
  if (!t.includes("/")) return t;
  const slash = t.lastIndexOf("/");
  return slash >= 0 && slash < t.length - 1 ? t.slice(slash + 1) : t;
}

/**
 * Basename only when the path is rooted in a trusted system bin
 * directory. Otherwise preserve the full path so policy rules cannot be
 * bypassed by dropping a same-named binary into a writable directory.
 */
function basenameTrusted(t: string): string {
  if (!t.includes("/")) return t;
  for (const prefix of TRUSTED_BIN_PREFIXES) {
    if (t.startsWith(prefix)) {
      const rest = t.slice(prefix.length);
      if (rest.length > 0 && !rest.includes("/")) return rest;
    }
  }
  return t;
}

/**
 * Absolute paths outside the trusted allowlist (`/nix/store/...`,
 * `/tmp/git`, `./sudo`, etc.) are neither safe to basename (would
 * leak trust to an attacker-dropped binary) nor safe to keep as a
 * distinct prefix (loses subcommand-specific deny rules on the
 * real binary name). Route them to the `!complex` sentinel so
 * operators must explicitly opt in per-command.
 */
function isUntrustedPathBinary(t: string): boolean {
  if (!t.includes("/")) return false;
  for (const prefix of TRUSTED_BIN_PREFIXES) {
    if (t.startsWith(prefix)) {
      const rest = t.slice(prefix.length);
      if (rest.length > 0 && !rest.includes("/")) return false; // trusted
    }
  }
  return true;
}

/**
 * Peel a known wrapper's options according to its spec. Returns the new
 * index into `tokens`, or `-1` when an unknown flag is encountered (caller
 * should treat as fail-closed and preserve the wrapper as the head).
 */
function peelWrapperOptions(tokens: readonly string[], from: number, spec: WrapperSpec): number {
  let i = from;
  while (i < tokens.length) {
    const t = tokens[i] ?? "";
    if (!t.startsWith("-")) break;
    // `--` sentinel ends option parsing; remaining tokens are the
    // inner command (`env -- sudo rm` → inner is `sudo rm`).
    if (t === "--") {
      return i + 1;
    }
    // --long=value is single-token; only allow if the long-form is known.
    if (t.startsWith("--") && t.includes("=")) {
      const name = t.slice(0, t.indexOf("="));
      if (spec.argFlags.has(name) || spec.boolFlags.has(name)) {
        i++;
        continue;
      }
      return -1;
    }
    if (spec.argFlags.has(t)) {
      i += 2;
      continue;
    }
    if (spec.boolFlags.has(t)) {
      i++;
      continue;
    }
    // Bundled short form: `-oL`, `-i0` etc., where `-o` / `-i` are known
    // arg-taking short flags and the rest of the token is the inline value.
    let bundled = false;
    for (const flag of spec.argFlags) {
      if (
        flag.length === 2 &&
        flag.startsWith("-") &&
        !flag.startsWith("--") &&
        t.startsWith(flag) &&
        t.length > 2
      ) {
        i++;
        bundled = true;
        break;
      }
    }
    if (bundled) continue;
    return -1;
  }
  return i;
}

/** Single peel: strip leading env assignments + one wrapper (if any). */
function normalizeOnce(tokens: readonly string[]): readonly string[] {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === undefined || !ENV_ASSIGN.test(t)) break;
    i++;
  }
  const head = tokens[i];
  if (head === undefined) return tokens.slice(i);
  const base = basenameTrusted(head);

  if (FLAGLESS_WRAPPERS.has(base)) {
    let wrapperEnd = i + 1;
    // Accept `--` end-of-options — the next token(s) are the inner
    // command (`command -- sudo rm`, `exec -- git push`).
    if (tokens[wrapperEnd] === "--") wrapperEnd++;
    const next = tokens[wrapperEnd] ?? "";
    // Flagged forms we haven't modeled (`command -p`, `exec -a fake`,
    // `nohup -x …`) must NOT collapse to the wrapper name — that
    // would let an inner denied command hide behind a broadly-
    // allowed wrapper prefix. Signal fail-closed via the sentinel so
    // prefix() propagates UNSAFE_PREFIX.
    if (next.startsWith("-")) return [UNSAFE_SENTINEL_TOKEN];
    return tokens.slice(wrapperEnd);
  }

  const spec = WRAPPER_SPECS[base];
  if (spec !== undefined) {
    const wrapperStart = i;
    i++;
    // env: also consume post-wrapper VAR=value assignments
    if (base === "env") {
      while (i < tokens.length && ENV_ASSIGN.test(tokens[i] ?? "")) i++;
    }
    const afterOpts1 = peelWrapperOptions(tokens, i, spec);
    if (afterOpts1 < 0) {
      // Unknown flag — fail closed: preserve wrapper as head.
      return [base, ...tokens.slice(wrapperStart + 1)];
    }
    i = afterOpts1;
    if (base === "timeout") {
      // Optional duration arg between flag groups.
      if (i < tokens.length && /^\d/.test(tokens[i] ?? "")) i++;
      const afterOpts2 = peelWrapperOptions(tokens, i, spec);
      if (afterOpts2 < 0) return [base, ...tokens.slice(wrapperStart + 1)];
      i = afterOpts2;
    }
    return tokens.slice(i);
  }

  // Not a wrapper — basename the head and leave the rest alone.
  return [base, ...tokens.slice(i + 1)];
}

/**
 * Iterate `normalizeOnce` to a true fixed point. Each peel consumes at
 * least one token, so the loop terminates in at most `tokens.length`
 * iterations regardless of stacking depth. No arbitrary cutoff — an
 * attacker cannot silently retain a harmless-looking wrapper prefix by
 * chaining more than N wrappers.
 */
function normalize(tokens: readonly string[]): readonly string[] {
  let current = tokens;
  // Safety guard: each iteration strictly reduces or preserves length and
  // returns a different array when it peels. `max` is an upper bound on
  // possible peels (never reachable in practice).
  const max = current.length + 1;
  for (let i = 0; i < max; i++) {
    const next = normalizeOnce(current);
    if (next.length === current.length && next.every((t, idx) => t === current[idx])) {
      return current;
    }
    current = next;
  }
  return current;
}

/** Shell interpreter binaries whose `-c <arg>` form wraps a nested command. */
const SHELL_INTERP = /^(?:ba|z|da|a)?sh$/;

/**
 * Minimal shell-aware tokenizer. Handles single and double quoted strings
 * (preserving their contents as one token) and backslash escapes. Enough
 * to correctly split `bash -c "sudo rm"` into three tokens with quotes
 * stripped. Does NOT handle command substitution, variable expansion,
 * heredocs, or other complex shell grammar — those caller-visible commands
 * are caught by the structural `DANGEROUS_PATTERNS` regex set instead.
 */
function shellTokenize(s: string): readonly string[] {
  const tokens: string[] = [];
  let buf = "";
  let inBuf = false;
  let quote: "'" | '"' | null = null;
  const len = s.length;
  for (let i = 0; i < len; i++) {
    const c = s[i];
    if (c === undefined) break;
    if (quote !== null) {
      if (c === quote) {
        quote = null;
        // A closing quote adjacent to more chars still belongs to buf
        continue;
      }
      if (c === "\\" && quote === '"' && i + 1 < len) {
        buf += s[i + 1] ?? "";
        i++;
        inBuf = true;
        continue;
      }
      buf += c;
      inBuf = true;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inBuf = true;
      continue;
    }
    // Bash ANSI-C (`$'…'`) and locale (`$"…"`) quoting: skip the `$`
    // and let the next iteration open the quote. We don't expand
    // ANSI-C escape sequences (`\n`, `\t`, `\xNN`) inside, but the
    // resulting literal is close enough for policy tokenization and,
    // crucially, avoids a `$sudo` leakage where the `$` gets glued to
    // the quoted content as a new token.
    if (c === "$" && (s[i + 1] === "'" || s[i + 1] === '"')) {
      continue;
    }
    if (c === "\\" && i + 1 < len) {
      buf += s[i + 1] ?? "";
      i++;
      inBuf = true;
      continue;
    }
    if (c === " " || c === "\t" || c === "\n") {
      if (inBuf) {
        tokens.push(buf);
        buf = "";
        inBuf = false;
      }
      continue;
    }
    buf += c;
    inBuf = true;
  }
  if (inBuf) tokens.push(buf);
  return tokens;
}

/** Bash short flags that take a separate-token argument. */
const BASH_SHORT_FLAGS_WITH_ARG: ReadonlySet<string> = new Set([
  "-o", // `-o <option>` — set shopt-style long option
  "-O", // `-O <shopt>` — enable shopt
]);

/** Bash long flags that take a separate-token argument. */
const BASH_LONG_FLAGS_WITH_ARG: ReadonlySet<string> = new Set([
  "--rcfile",
  "--init-file",
  "--file",
]);

/**
 * When `cmdLine` is a shell-interpreter invocation that uses `-c <arg>`,
 * returns the inner script string. Scans the full token list for a
 * `-c`-family flag, handling the bash option grammar:
 *   - `-c`, `-lc`, `-ic`, `-eic` etc. → found, next token is the script.
 *   - `-o <opt>` and `-O <shopt>` consume a paired arg.
 *   - `--rcfile PATH`, `--init-file PATH`, `--file PATH` consume a paired arg.
 *   - `--long=value` is self-contained (one token).
 *   - Other short/long flags are flag-only.
 *   - `--` ends option parsing (anything after is script argv).
 *   - A non-flag token without a prior paired flag = script path; bail.
 *
 * Returns `null` when `-c` is not found before script argv starts.
 */
function extractShellDashCArgFromTokens(tokens: readonly string[]): string | null {
  if (tokens.length < 2) return null;

  const first = tokens[0];
  if (first === undefined) return null;
  // Interpreter-hop unwrap is only safe for a trusted shell binary:
  // `/usr/bin/bash -c "sudo rm"` → inherits policy of the inner command.
  // An attacker-writable `./bash` or `/tmp/bash` is arbitrary code and
  // must not collapse into a trusted-bash rule, so we use the strict
  // basename here.
  if (!SHELL_INTERP.test(basenameTrusted(first))) return null;

  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === undefined) return null;

    // End-of-options: -- sentinel.
    if (t === "--") return null;

    // -c / composite short flag with c (-lc, -ic, -eic, …)
    if (/^-[a-zA-Z]*c$/.test(t)) {
      const arg = tokens[i + 1];
      return arg !== undefined && arg.length > 0 ? arg : null;
    }

    // Flag with a separate-token argument: consume flag + arg.
    if (BASH_SHORT_FLAGS_WITH_ARG.has(t) || BASH_LONG_FLAGS_WITH_ARG.has(t)) {
      i += 2;
      continue;
    }

    // Flag-only (single-letter short, bundled short like -ex, long without =val,
    // --long=value single-token).
    if (t.startsWith("-")) {
      i++;
      continue;
    }

    // Non-flag token reached without a known flag-arg pairing: this is the
    // script path (`bash script.sh …`), not an interpreter hop. Bail.
    return null;
  }
  return null;
}

function extractShellDashCArg(cmdLine: string): string | null {
  return extractShellDashCArgFromTokens(shellTokenize(cmdLine));
}

const MAX_INTERP_DEPTH = 4;

/**
 * Sentinel prefix emitted when the command line contains shell control
 * operators (`;`, `&&`, `||`, `|`, `&`, command substitution), or exceeds
 * the safe interpreter-unwrap budget. Operators that want to permit
 * complex compound commands must opt in explicitly with a rule against
 * `!complex`. Defaults deny safely.
 */
export const UNSAFE_PREFIX = "!complex";

/**
 * Returns `true` if the unquoted portion of `s` contains any shell
 * control operator that would compose multiple simple commands into one
 * line: `;`, `&&`, `||`, `|`, `&`, `\n`, `$(…)`, or backticks. Newline
 * is equivalent to `;` in POSIX shell. Ignores operators inside single-
 * or double-quoted strings.
 */
function hasShellControlOperators(s: string): boolean {
  let quote: "'" | '"' | null = null;
  const len = s.length;
  for (let i = 0; i < len; i++) {
    const c = s[i];
    if (c === undefined) break;
    if (quote === "'") {
      // Single-quoted region is fully opaque — no expansions inside.
      if (c === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      // Double-quoted region: the shell STILL expands `$(...)` and
      // backticks inside, so those remain executable command-
      // substitution vectors. Keep scanning for them. Only suppress
      // the ordinary separators (`;`, `|`, `&`, newline, redirect).
      if (c === '"') {
        quote = null;
        continue;
      }
      if (c === "\\" && i + 1 < len) {
        i++;
        continue;
      }
      if (c === "`") return true;
      if (c === "$" && s[i + 1] === "(") return true;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === "\\" && i + 1 < len) {
      // Backslash-newline is line continuation, not a separator.
      i++;
      continue;
    }
    if (c === ";" || c === "|" || c === "&" || c === "`" || c === "\n") return true;
    if (c === "$" && s[i + 1] === "(") return true;
    // Process substitution `<(…)` / `>(…)` executes a nested command.
    // Plain redirections (`>`, `>>`, `<`, `<<<`) are intentionally NOT
    // treated as complex: `echo hi > /tmp/x` is one command with a
    // side effect and should keep its natural prefix (operators who
    // want to restrict file writes can deny `bash:echo` directly or
    // use sibling packages for target-aware checks).
    if ((c === "<" || c === ">") && s[i + 1] === "(") return true;
    // Subshell: `(sudo rm)` — `(` always triggers (function-def and
    // subshell are both compound-executing forms).
    if (c === "(" || c === ")") return true;
    // Group command `{ cmd; }` requires `{` as its own token (preceded
    // and followed by whitespace). Bare braces inside a token belong to
    // parameter expansion `${VAR}` or brace expansion `file{1,2}` — both
    // remain single-command forms that should keep their prefix.
    if (c === "{") {
      const prev = i > 0 ? s[i - 1] : "";
      const next = s[i + 1] ?? "";
      const prevWs = i === 0 || prev === " " || prev === "\t" || prev === "\n";
      const nextWs = next === " " || next === "\t" || next === "\n";
      if (prevWs && nextWs) return true;
      continue;
    }
    if (c === "}") {
      const prev = i > 0 ? s[i - 1] : "";
      // Group closer: `; }` or `\n}` or ` }`.
      if (prev === " " || prev === "\t" || prev === ";" || prev === "\n") return true;
    }
  }
  return false;
}

/**
 * Canonical permission prefix from a raw command string. Unwraps
 * shell-interpreter hops (`bash -c "sudo rm"` → prefix of `sudo rm`) and
 * applies wrapper normalization.
 *
 * Fails closed — returns `UNSAFE_PREFIX` ("!complex") — when:
 *   - The command contains shell control operators (`;`, `&&`, `||`, `|`,
 *     `&`, `$(…)`, backticks) — can't safely canonicalize to one prefix.
 *   - Interpreter-hop recursion exceeds `MAX_INTERP_DEPTH` — adversarial
 *     nesting should not silently collapse to the outer prefix.
 */
/**
 * Returns `true` when the tokenized command is any `env [opts…] -S
 * <script>` invocation. Walks every leading env option (not just the
 * first) so `env -i -S "sudo rm"` and `env -u PATH --split-string=...`
 * are all detected. `-S` evaluates its argument as a shell script
 * string; we cannot safely peel that arg, and we cannot cheaply parse
 * the script itself at this layer — so fail closed.
 */
function isEnvDashS(tokens: readonly string[]): boolean {
  let i = 0;
  while (i < tokens.length && ENV_ASSIGN.test(tokens[i] ?? "")) i++;
  const head = tokens[i];
  if (head === undefined) return false;
  if (basenameTrusted(head) !== "env") return false;
  i++;
  // Walk through every env option until we hit a non-flag token or
  // run out. Any `-S`/`--split-string` form at any position triggers
  // fail-closed.
  while (i < tokens.length) {
    const t = tokens[i] ?? "";
    if (ENV_ASSIGN.test(t)) {
      i++;
      continue;
    }
    if (!t.startsWith("-")) return false;
    if (t === "--") return false;
    if (t === "-S" || t === "--split-string" || t.startsWith("--split-string=")) {
      return true;
    }
    // Bundled short form that includes `S`: -iS, -uSx, etc.
    if (t.length > 1 && !t.startsWith("--") && t.includes("S")) return true;
    // Known arg-taking env flags consume their arg.
    if (t === "-u" || t === "--unset" || t === "-C" || t === "--chdir") {
      i += 2;
      continue;
    }
    // --long=value is single-token.
    if (t.startsWith("--") && t.includes("=")) {
      i++;
      continue;
    }
    // Any other flag: advance one.
    i++;
  }
  return false;
}

export function canonicalPrefix(cmdLine: string, depth: number = 0): string {
  const trimmed = cmdLine.trim();
  if (trimmed.length === 0) return "";
  if (hasShellControlOperators(trimmed)) return UNSAFE_PREFIX;
  if (depth >= MAX_INTERP_DEPTH) return UNSAFE_PREFIX;

  // First try: direct shell-interp hop on the raw command.
  const directInner = extractShellDashCArg(trimmed);
  if (directInner !== null) return canonicalPrefix(directInner, depth + 1);

  // `env -S "<script>"` evaluates its argument as a shell script —
  // same risk profile as `bash -c`, but bash-classifier cannot safely
  // recurse into the string without shell parsing. Fail closed.
  const rawTokens = shellTokenize(trimmed);
  if (isEnvDashS(rawTokens)) return UNSAFE_PREFIX;

  // Normalize (strip env assignments, peel wrappers). After
  // normalization, the leading token may now be a shell interpreter
  // or an `env -S` form that was previously hidden behind a wrapper
  // (`command env -S 'sudo rm'`, `nohup env -S …`, `timeout 30 env -S …`,
  // `env bash -c "sudo rm"`, `timeout 30 bash -c "sudo rm"`). Re-check
  // both fail-closed conditions before falling back to prefix lookup.
  const normalized = normalize(rawTokens);
  if (isEnvDashS(normalized)) return UNSAFE_PREFIX;
  const innerAfterNormalize = extractShellDashCArgFromTokens(normalized);
  if (innerAfterNormalize !== null) return canonicalPrefix(innerAfterNormalize, depth + 1);

  return prefix(normalized);
}

export function prefix(tokens: readonly string[]): string {
  if (tokens.length === 0) return "";

  const normalized = normalize(tokens);
  if (normalized.length === 0) return "";

  const first = normalized[0];
  if (first === undefined) return "";
  // Fail-closed sentinel from normalize (e.g. flagged `command -p`).
  if (first === UNSAFE_SENTINEL_TOKEN) return UNSAFE_PREFIX;
  // Untrusted absolute/relative paths (`./git`, `/tmp/sudo`,
  // `/nix/store/.../bin/sudo`, `~/bin/git`) must not share a
  // permission key with the trusted binary of the same name, but
  // keeping them as a distinct path-qualified prefix would let them
  // slip past subcommand deny rules (`deny: bash:sudo*` would miss
  // `bash:/nix/store/.../bin/sudo`). Route through the `!complex`
  // sentinel so operators opt in per-command.
  if (isUntrustedPathBinary(first)) return UNSAFE_PREFIX;
  // ARITY lookup uses the loose basename for the remaining trusted
  // paths already handled by normalize's basenameTrusted.
  const firstKey = basenameLoose(first);

  // Peel per-command global options (git -c, docker --context, etc.)
  // so `git -c protocol.version=2 push` resolves to `git push`, not
  // `git -c`. Without this, deny-first rules like
  // `deny: bash:git push*` are bypassable with a legal global option.
  const preSpec = COMMAND_PRE_OPTIONS[firstKey];
  let optsEnd = 1;
  if (preSpec !== undefined) {
    const afterOpts = peelWrapperOptions(normalized, 1, preSpec);
    if (afterOpts < 0) {
      // Unknown pre-option (e.g. `git --literal-pathspecs push`).
      // Our per-command spec is hand-maintained and will always lag
      // real-world CLIs; rather than emit a new attacker-controllable
      // prefix (`git --literal-pathspecs`) that satisfies rules like
      // `allow: bash:git *` without matching subcommand-specific
      // denies, fail closed to the sentinel so the operator-controlled
      // `!complex` rule fires.
      return UNSAFE_PREFIX;
    }
    optsEnd = afterOpts;
  }

  // If pre-options consumed tokens, reconstruct a view with the
  // command-name head + post-options tail so the ARITY lookup and
  // multi-token key matching work as if the pre-options weren't there.
  const view = optsEnd > 1 ? [first, ...normalized.slice(optsEnd)] : normalized;

  let bestArity = ARITY[firstKey] ?? 1;

  // Look for longer multi-token keys (e.g. `npm run`, `docker compose`).
  for (let keyLen = 2; keyLen <= view.length; keyLen++) {
    const segment = view.slice(0, keyLen);
    const head = segment[0] ?? "";
    const rest = segment.slice(1);
    const candidate = [basenameLoose(head), ...rest].join(" ");
    const a = ARITY[candidate];
    if (a !== undefined) {
      bestArity = a;
    }
  }

  const take = Math.min(bestArity, view.length);
  return view.slice(0, take).join(" ");
}
