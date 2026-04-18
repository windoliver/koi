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

function normalize(tokens: readonly string[]): readonly string[] {
  let i = 0;
  // Strip leading VAR=value assignments (shell-syntax inline env)
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === undefined || !ENV_ASSIGN.test(t)) break;
    i++;
  }
  // Peel one wrapper (basename-normalized). One level is enough in practice;
  // avoids unbounded iteration on adversarial inputs like `env env env …`.
  const head = tokens[i];
  if (head !== undefined) {
    const base = basename(head);
    if (WRAPPERS.has(base)) {
      i++;
      // env: consume any following VAR=value assignments
      if (base === "env") {
        while (i < tokens.length && ENV_ASSIGN.test(tokens[i] ?? "")) i++;
      }
      // timeout: consume one duration arg (digits + optional unit suffix)
      if (base === "timeout" && i < tokens.length) {
        const dur = tokens[i] ?? "";
        if (/^\d/.test(dur)) i++;
      }
      // stdbuf: consume `-o…`/`-e…`/`-i…` option args (single token each)
      if (base === "stdbuf") {
        while (i < tokens.length && (tokens[i] ?? "").startsWith("-")) i++;
      }
      // Basename the new leading token if any
      const next = tokens[i];
      if (next !== undefined) {
        return [basename(next), ...tokens.slice(i + 1)];
      }
      return [];
    }
    // Not a wrapper — basename the leading token and return
    return [base, ...tokens.slice(i + 1)];
  }
  return tokens.slice(i);
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
