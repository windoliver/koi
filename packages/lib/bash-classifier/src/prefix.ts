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
 * Iterate `normalizeOnce` to a fixed point with a bounded depth so stacked
 * wrappers (`env timeout 30 sudo rm`, `command env sudo rm`) reduce to the
 * underlying action, while adversarial inputs like `env env env …` cannot
 * pin the loop.
 */
const MAX_PEEL_DEPTH = 8;

function normalize(tokens: readonly string[]): readonly string[] {
  let current = tokens;
  for (let i = 0; i < MAX_PEEL_DEPTH; i++) {
    const next = normalizeOnce(current);
    if (next.length === current.length && next.every((t, idx) => t === current[idx])) {
      break;
    }
    current = next;
  }
  return current;
}

/** Shell interpreter binaries whose `-c <arg>` form wraps a nested command. */
const SHELL_INTERP = /^(?:ba|z|da|a)?sh$/;

/**
 * When `cmd` is a shell-interpreter invocation like `bash -c "<arg>"`,
 * returns the inner script string with outer quotes stripped. Handles
 * basename'd absolute paths (`/usr/bin/bash`), POSIX `-c` plus composite
 * flags like `-lc`, `-ic`, `-eic`. Returns `null` for anything else.
 */
function extractShellDashCArg(cmdLine: string): string | null {
  const trimmed = cmdLine.trim();
  if (trimmed.length === 0) return null;

  const firstSpace = trimmed.indexOf(" ");
  if (firstSpace < 0) return null;

  const firstToken = trimmed.slice(0, firstSpace);
  const firstBase = basename(firstToken);
  if (!SHELL_INTERP.test(firstBase)) return null;

  const rest = trimmed.slice(firstSpace).trimStart();
  // Match a -c or composite-c flag like -lc / -ic / -eic
  const flagMatch = rest.match(/^-[a-zA-Z]*c(?:\s+|$)/);
  if (flagMatch === null) return null;

  let arg = rest.slice(flagMatch[0].length).trimStart();
  if (arg.length === 0) return null;

  // Strip outer matching quotes (single or double) when they span the arg.
  const quote = arg[0];
  if ((quote === '"' || quote === "'") && arg.endsWith(quote) && arg.length >= 2) {
    arg = arg.slice(1, -1);
  }
  return arg.length > 0 ? arg : null;
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
