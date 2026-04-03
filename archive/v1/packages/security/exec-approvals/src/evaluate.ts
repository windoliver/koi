/**
 * Pure evaluation function for tool request approval decisions.
 *
 * Extracted from middleware.ts to enable reuse in parent-side approval routing.
 * The 6-step evaluation order is a security invariant — do not reorder.
 */

import type { JsonObject } from "@koi/core/common";

import { findFirstAskMatch, matchesAnyCompound } from "./pattern.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result of evaluating a tool request against the rule set.
 *
 * - `allow` — tool matches an allow rule, proceed without prompting
 * - `deny` — tool matches a deny rule, block with reason
 * - `ask` — tool matches an ask rule, prompt for approval
 */
export type EvaluationResult =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly reason: string }
  | { readonly kind: "ask"; readonly matchedPattern: string };

/**
 * Configuration for the evaluation function.
 * All pattern arrays should already be normalized.
 */
export interface EvaluationConfig {
  readonly baseDeny: readonly string[];
  readonly sessionDeny: readonly string[];
  readonly sessionAllow: readonly string[];
  readonly baseAllow: readonly string[];
  readonly baseAsk: readonly string[];
  readonly extractCommand: (input: JsonObject) => string;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Evaluate a tool request against a layered rule set.
 *
 * Evaluation order (security invariant — do not reorder):
 * 1. base deny    → ABSOLUTE, cannot be overridden by any session approval
 * 2. session deny → accumulated deny_always decisions
 * 3. session allow → accumulated allow_session / allow_always decisions
 * 4. base allow   → static allow list
 * 5. base ask     → trigger onAsk, handle ProgressiveDecision
 * 6. default deny → no rule matched
 */
export function evaluateToolRequest(
  toolId: string,
  input: JsonObject,
  config: EvaluationConfig,
): EvaluationResult {
  const { baseDeny, sessionDeny, sessionAllow, baseAllow, baseAsk, extractCommand } = config;

  // 1. Base deny — absolute
  if (matchesAnyCompound(baseDeny, toolId, input, extractCommand)) {
    return { kind: "deny", reason: `Tool "${toolId}" is denied by policy` };
  }

  // 2. Session deny (accumulated deny_always)
  if (matchesAnyCompound(sessionDeny, toolId, input, extractCommand)) {
    return { kind: "deny", reason: `Tool "${toolId}" is denied by session policy` };
  }

  // 3. Session allow (accumulated allow_session / allow_always)
  if (matchesAnyCompound(sessionAllow, toolId, input, extractCommand)) {
    return { kind: "allow" };
  }

  // 4. Base allow
  if (matchesAnyCompound(baseAllow, toolId, input, extractCommand)) {
    return { kind: "allow" };
  }

  // 5. Base ask
  const matchedPattern = findFirstAskMatch(baseAsk, toolId, input, extractCommand);
  if (matchedPattern !== undefined) {
    return { kind: "ask", matchedPattern };
  }

  // 6. Default deny
  return { kind: "deny", reason: `Tool "${toolId}" is not in the allow list (default deny)` };
}
