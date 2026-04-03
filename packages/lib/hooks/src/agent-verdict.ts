/**
 * HookVerdict synthetic tool — structured output contract for agent hooks.
 *
 * Agent hooks must call this tool exactly once to deliver their verdict.
 * The stop guard (in agent-executor.ts) prevents the sub-agent from
 * completing without calling it.
 */

import type { HookDecision } from "@koi/core";

// ---------------------------------------------------------------------------
// Tool name + schema
// ---------------------------------------------------------------------------

/** Name of the synthetic tool injected into agent hooks. */
export const HOOK_VERDICT_TOOL_NAME = "HookVerdict" as const;

/**
 * JSON Schema for the HookVerdict tool input.
 * Kept as a plain object so it can be serialized into SpawnRequest.
 */
export const HOOK_VERDICT_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    ok: { type: "boolean" as const, description: "Whether the verification condition was met" },
    reason: { type: "string" as const, description: "Explanation of your verdict" },
  },
  required: ["ok"] as const,
  additionalProperties: false,
} as const;

/** Default system prompt for verification agents. */
export const DEFAULT_AGENT_SYSTEM_PROMPT: string =
  "You are a verification agent. Analyze the provided event data and use your tools to investigate. " +
  "When done, call HookVerdict with your assessment. You MUST call HookVerdict exactly once.";

// ---------------------------------------------------------------------------
// Verdict type
// ---------------------------------------------------------------------------

/** Parsed verdict from a HookVerdict tool call. */
export interface HookVerdictResult {
  readonly ok: boolean;
  readonly reason: string | undefined;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse raw SpawnResult output into a HookVerdictResult.
 *
 * Expects JSON: `{ "ok": boolean, "reason"?: string }`.
 * Returns undefined if the output cannot be parsed as a valid verdict.
 */
export function parseVerdictOutput(output: string): HookVerdictResult | undefined {
  const trimmed = output.trim();
  if (trimmed === "") return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }

  const obj = parsed as Record<string, unknown>;
  if (typeof obj.ok !== "boolean") return undefined;

  return {
    ok: obj.ok,
    reason: typeof obj.reason === "string" ? obj.reason : undefined,
  };
}

/**
 * Convert a HookVerdictResult into a HookDecision.
 *
 * - `ok: true` → `{ kind: "continue" }`
 * - `ok: false` → `{ kind: "block", reason }`
 *
 * Agent hooks only produce continue/block — never modify.
 */
export function verdictToDecision(verdict: HookVerdictResult): HookDecision {
  if (verdict.ok) {
    return { kind: "continue" };
  }
  return { kind: "block", reason: verdict.reason ?? "Agent hook verification failed" };
}
