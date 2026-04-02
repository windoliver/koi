/**
 * Verdict parsing utilities — extract structured decisions from model output.
 */

import type { HookVerdict } from "@koi/core";

/** Parsed verdict from model output. */
export interface ParsedVerdict {
  readonly ok: boolean;
  readonly reason?: string | undefined;
}

/** Keywords that heuristically indicate approval. */
const APPROVE_KEYWORDS = ["ok", "pass", "approve", "continue", "allow", "yes"] as const;

/**
 * Parse model output as a structured verdict.
 *
 * Attempts JSON parsing first. On failure, falls back to keyword heuristics:
 * if the lowercased text contains an approval keyword, treat as ok:true;
 * otherwise ok:false with the raw text as reason.
 */
export function parseVerdictOutput(raw: string): ParsedVerdict {
  const trimmed = raw.trim();

  // Try JSON parse first
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null && "ok" in parsed) {
      const obj = parsed as Record<string, unknown>;
      const ok = Boolean(obj["ok"]);
      const reason = typeof obj["reason"] === "string" ? obj["reason"] : undefined;
      return reason !== undefined ? { ok, reason } : { ok };
    }
  } catch {
    // Fall through to heuristic
  }

  // Heuristic: check for approval keywords
  const lower = trimmed.toLowerCase();
  const approved = APPROVE_KEYWORDS.some((kw) => lower.includes(kw));

  if (approved) {
    return { ok: true };
  }

  return { ok: false, reason: trimmed };
}

/**
 * Map a parsed verdict to a HookVerdict discriminated union.
 */
export function mapVerdictToDecision(verdict: ParsedVerdict): HookVerdict {
  if (verdict.ok) {
    return { kind: "continue" };
  }
  return { kind: "block", reason: verdict.reason ?? "Blocked by prompt hook" };
}
