/**
 * `prefix(tokens)` — canonical permission key from a tokenized command.
 *
 * Uses the longest `ARITY` key that is a leading prefix of `tokens`. Falls
 * back to arity 1 when no key matches (unknown binary → the binary name
 * alone becomes the prefix).
 *
 * Pure function. No regex. No side effects.
 */

import { ARITY } from "./arity.js";

export function prefix(tokens: readonly string[]): string {
  if (tokens.length === 0) return "";

  // Default: arity 1 (binary name alone).
  const first = tokens[0];
  if (first === undefined) return "";
  let bestArity = ARITY[first] ?? 1;

  // Look for longer multi-token keys. In practice keys are at most 2 tokens,
  // but allow up to tokens.length so the table can grow.
  for (let keyLen = 2; keyLen <= tokens.length; keyLen++) {
    const candidate = tokens.slice(0, keyLen).join(" ");
    const a = ARITY[candidate];
    if (a !== undefined) {
      bestArity = a;
    }
  }

  const take = Math.min(bestArity, tokens.length);
  return tokens.slice(0, take).join(" ");
}
