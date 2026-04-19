import type { KoiError, WatchPattern } from "@koi/core";
import { validation } from "@koi/core";
import { RE2 } from "re2-wasm";

export interface CompiledPattern {
  readonly event: string;
  readonly re: { readonly test: (input: string) => boolean };
}

export type CompileResult =
  | { readonly ok: true; readonly value: readonly CompiledPattern[] }
  | { readonly ok: false; readonly error: KoiError };

const MAX_PATTERN_CHARS = 256;
const MAX_PATTERNS = 16;
const EVENT_RE = /^(?!__)[a-z0-9_-]{1,64}$/;
const DISALLOWED_FLAGS = /[gy]/;

/**
 * Compile user-supplied watch patterns.
 *
 * - Validates event names against strict identifier regex (excludes `__`-prefixed reserved names).
 * - Validates pattern length (≤256 chars).
 * - Validates max pattern count (≤16).
 * - Rejects `g` and `y` flags.
 * - Always injects the `u` (Unicode) flag required by re2-wasm.
 * - Catches RE2 compile errors (backreferences, lookahead/lookbehind) and returns typed VALIDATION.
 */
export function compilePatterns(input: readonly WatchPattern[]): CompileResult {
  if (input.length > MAX_PATTERNS) {
    return fail(`Too many watch patterns (got ${input.length}, max ${MAX_PATTERNS})`);
  }

  const compiled: CompiledPattern[] = [];
  for (const [i, w] of input.entries()) {
    if (w.pattern.length === 0 || w.pattern.length > MAX_PATTERN_CHARS) {
      return fail(`watch_patterns[${i}].pattern length must be 1..${MAX_PATTERN_CHARS}`);
    }
    if (!EVENT_RE.test(w.event)) {
      return fail(
        `watch_patterns[${i}].event must match /^(?!__)[a-z0-9_-]{1,64}$/ (got ${JSON.stringify(w.event)})`,
      );
    }
    const userFlags = w.flags ?? "i";
    if (DISALLOWED_FLAGS.test(userFlags)) {
      return fail(
        `watch_patterns[${i}].flags rejected: 'g' and 'y' are disallowed (got '${userFlags}')`,
      );
    }
    // Always add the mandatory 'u' flag for re2-wasm. Deduplicate if user already passed 'u'.
    const flags = userFlags.includes("u") ? userFlags : `${userFlags}u`;
    try {
      const re = new RE2(w.pattern, flags);
      compiled.push({ event: w.event, re });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return fail(
        `watch_patterns[${i}] rejected by RE2 (unsupported construct? backreferences/lookahead/lookbehind not supported): ${msg}`,
      );
    }
  }
  return { ok: true, value: compiled };
}

function fail(message: string): CompileResult {
  return { ok: false, error: validation(message) };
}
