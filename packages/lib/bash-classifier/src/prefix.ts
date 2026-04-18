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

/** Per-wrapper option grammar. Unknown flags fail closed. */
interface WrapperSpec {
  readonly argFlags: ReadonlySet<string>; // flag + next token
  readonly boolFlags: ReadonlySet<string>; // flag only
}

const WRAPPER_SPECS: Readonly<Record<string, WrapperSpec>> = {
  env: {
    argFlags: new Set(["-u", "--unset", "-S", "--split-string", "-C", "--chdir"]),
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
 * Peel a known wrapper's options according to its spec. Returns the new
 * index into `tokens`, or `-1` when an unknown flag is encountered (caller
 * should treat as fail-closed and preserve the wrapper as the head).
 */
function peelWrapperOptions(tokens: readonly string[], from: number, spec: WrapperSpec): number {
  let i = from;
  while (i < tokens.length) {
    const t = tokens[i] ?? "";
    if (!t.startsWith("-")) break;
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
    const wrapperEnd = i + 1;
    const next = tokens[wrapperEnd] ?? "";
    // If the next token is a flag, we haven't modeled it — fail closed by
    // preserving the wrapper as the head token.
    if (next.startsWith("-")) return [base, ...tokens.slice(wrapperEnd)];
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
function extractShellDashCArg(cmdLine: string): string | null {
  const tokens = shellTokenize(cmdLine);
  if (tokens.length < 2) return null;

  const first = tokens[0];
  if (first === undefined) return null;
  // Interpreter-hop unwrap is only safe for a trusted shell binary:
  // `/usr/bin/bash -c "sudo rm"` → inherits policy of the inner command.
  // An attacker-writable `./bash` or `/tmp/bash` is arbitrary code and
  // must not collapse into a trusted-bash rule, so we use the strict
  // basename here. Untrusted path-qualified shells remain as their own
  // prefix (`./bash`, `/tmp/bash`) for the caller to rule on explicitly.
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
    if (quote !== null) {
      if (c === quote) {
        quote = null;
      } else if (c === "\\" && quote === '"' && i + 1 < len) {
        i++;
      }
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
export function canonicalPrefix(cmdLine: string, depth: number = 0): string {
  const trimmed = cmdLine.trim();
  if (trimmed.length === 0) return "";
  if (hasShellControlOperators(trimmed)) return UNSAFE_PREFIX;
  if (depth >= MAX_INTERP_DEPTH) return UNSAFE_PREFIX;
  const inner = extractShellDashCArg(trimmed);
  if (inner !== null) return canonicalPrefix(inner, depth + 1);
  // Use shell-aware tokenization so quoted env assignments like
  // `FOO="x y" sudo rm` stay as a single token and the ENV_ASSIGN
  // strip in normalize() can peel them correctly. Naive whitespace
  // split would fragment the quoted value into multiple tokens and
  // let a crafted quote leak as the derived prefix.
  return prefix(shellTokenize(trimmed));
}

export function prefix(tokens: readonly string[]): string {
  if (tokens.length === 0) return "";

  const normalized = normalize(tokens);
  if (normalized.length === 0) return "";

  const first = normalized[0];
  if (first === undefined) return "";
  // ARITY lookup uses the loose basename so untrusted path-qualified
  // binaries (`./git`, `/tmp/git`) still pick up the correct arity and
  // produce `./git push` / `/tmp/git push` as the permission key. The
  // path stays visible in the output so a rule for the trusted binary
  // doesn't leak to the untrusted path.
  const firstKey = basenameLoose(first);
  let bestArity = ARITY[firstKey] ?? 1;

  // Look for longer multi-token keys (e.g. `npm run`, `docker compose`).
  for (let keyLen = 2; keyLen <= normalized.length; keyLen++) {
    const segment = normalized.slice(0, keyLen);
    const head = segment[0] ?? "";
    const rest = segment.slice(1);
    const candidate = [basenameLoose(head), ...rest].join(" ");
    const a = ARITY[candidate];
    if (a !== undefined) {
      bestArity = a;
    }
  }

  const take = Math.min(bestArity, normalized.length);
  return normalized.slice(0, take).join(" ");
}
