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

// Wrappers whose leading occurrence is peeled off to expose the real
// command. These do NOT include `sudo` (which is itself a security-
// relevant action) or shells like `bash` / `sh` (whose `-c` form is
// flagged by the structural pattern registry).
const WRAPPERS: ReadonlySet<string> = new Set([
  "env",
  "command",
  "builtin",
  "exec",
  "nohup",
  "time",
  "timeout",
  "stdbuf",
  "nice",
  "ionice",
]);

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

function basename(t: string): string {
  if (!t.includes("/")) return t;
  const slash = t.lastIndexOf("/");
  return slash >= 0 && slash < t.length - 1 ? t.slice(slash + 1) : t;
}

/**
 * Consume leading option tokens, pairing each single-letter short flag
 * (`-n`, `-c`, `-s`, `-k`, `-p`) with the following token as its arg.
 * Conservative: over-consumes a benign extra token rather than leaving
 * a raw flag as the new leading prefix, which would let an attacker
 * fall back into the generic bash permission bucket.
 */
function consumeFlagsAndArgs(tokens: readonly string[], from: number): number {
  let i = from;
  while (i < tokens.length) {
    const t = tokens[i] ?? "";
    if (!t.startsWith("-")) break;
    i++;
    // Single-letter short flag (-n / -c / -k etc.) — assume it takes an
    // arg and consume the next token too. --long=val is self-contained;
    // --long or -xy (bundled short) we treat as flag-only.
    if (/^-[a-zA-Z]$/.test(t) && i < tokens.length) i++;
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
  const base = basename(head);
  if (WRAPPERS.has(base)) {
    i++;
    if (base === "env") {
      while (i < tokens.length && ENV_ASSIGN.test(tokens[i] ?? "")) i++;
    } else if (base === "nice" || base === "ionice" || base === "stdbuf") {
      // nice -n <pri>, ionice -c <class> -n <level>, stdbuf -oL -eL …
      i = consumeFlagsAndArgs(tokens, i);
    } else if (base === "timeout") {
      // `timeout` accepts flags before and/or after the duration, e.g.
      // `timeout --signal=KILL 30 cmd` or `timeout 30 --preserve-status cmd`.
      i = consumeFlagsAndArgs(tokens, i);
      if (i < tokens.length && /^\d/.test(tokens[i] ?? "")) i++;
      i = consumeFlagsAndArgs(tokens, i);
    }
    return tokens.slice(i);
  }
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
  if (!SHELL_INTERP.test(basename(first))) return null;

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
 * Canonical permission prefix from a raw command string, unwrapping
 * shell-interpreter hops (`bash -c "sudo rm"` → prefix of `sudo rm`).
 *
 * Bounded recursion depth prevents adversarial nesting
 * (`bash -c "sh -c 'bash -c ...'"`) from pinning the extractor. When the
 * budget is exhausted, falls back to the outer prefix.
 */
export function canonicalPrefix(cmdLine: string, depth: number = 0): string {
  const trimmed = cmdLine.trim();
  if (trimmed.length === 0) return "";
  if (depth < MAX_INTERP_DEPTH) {
    const inner = extractShellDashCArg(trimmed);
    if (inner !== null) return canonicalPrefix(inner, depth + 1);
  }
  return prefix(trimmed.split(/\s+/));
}

export function prefix(tokens: readonly string[]): string {
  if (tokens.length === 0) return "";

  const normalized = normalize(tokens);
  if (normalized.length === 0) return "";

  const first = normalized[0];
  if (first === undefined) return "";
  let bestArity = ARITY[first] ?? 1;

  // Look for longer multi-token keys. Keys are at most 2 tokens in practice.
  for (let keyLen = 2; keyLen <= normalized.length; keyLen++) {
    const candidate = normalized.slice(0, keyLen).join(" ");
    const a = ARITY[candidate];
    if (a !== undefined) {
      bestArity = a;
    }
  }

  const take = Math.min(bestArity, normalized.length);
  return normalized.slice(0, take).join(" ");
}
