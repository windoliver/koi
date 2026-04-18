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
    }
    if (base === "timeout" && i < tokens.length) {
      const dur = tokens[i] ?? "";
      if (/^\d/.test(dur)) i++;
    }
    if (base === "stdbuf") {
      while (i < tokens.length && (tokens[i] ?? "").startsWith("-")) i++;
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

/**
 * When `cmdLine` is a shell-interpreter invocation that uses `-c <arg>`,
 * returns the inner script string. Scans past an arbitrary number of
 * leading flag tokens (e.g. `bash -x -c …`, `bash --noprofile -c …`) and
 * stops on the first non-flag token (which would be a script path or
 * positional arg, not a bash option). Uses shell-aware tokenization so
 * quoted `-c "sudo rm"` is recognised as a single inner script argument.
 * Returns `null` if we can't confidently extract the inner command.
 */
function extractShellDashCArg(cmdLine: string): string | null {
  const tokens = shellTokenize(cmdLine);
  if (tokens.length < 2) return null;

  const first = tokens[0];
  if (first === undefined) return null;
  if (!SHELL_INTERP.test(basename(first))) return null;

  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === undefined) return null;
    // Composite short-flag form that includes `c`: -c, -lc, -ic, -eic …
    if (/^-[a-zA-Z]*c$/.test(t)) {
      const arg = tokens[i + 1];
      return arg !== undefined && arg.length > 0 ? arg : null;
    }
    // Any leading flag token — keep scanning.
    if (t.startsWith("-")) continue;
    // Non-flag, non-c token (script path, positional arg) before we
    // found `-c`: bail rather than guess. The caller's rule on the
    // shell interpreter itself (`bash:bash*`) still applies.
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
