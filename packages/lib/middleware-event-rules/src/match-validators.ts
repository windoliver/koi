/**
 * Match-clause validation helpers for `ruleSchema`. Extracted from
 * rule-schema.ts to keep individual files under the project's
 * complexity budget. No public exports outside the package.
 */

import type { RuleEventType } from "./types.js";

const TOOL_CALL_CORE_FIELDS = [
  "toolId",
  "ok",
  "blocked",
  "blockedByHook",
  "reason",
  "agentId",
  "sessionId",
  "turnIndex",
] as const;
const TOOL_CALL_CORE_LOWER = new Map<string, string>(
  TOOL_CALL_CORE_FIELDS.map((f) => [f.toLowerCase(), f]),
);
const TURN_COMPLETE_FIELDS = new Set(["turnIndex", "agentId", "sessionId"]);
const SESSION_FIELDS = new Set(["agentId", "sessionId", "userId", "channelId"]);

/**
 * Damerau-Levenshtein with cap=1: true when `a` and `b` differ by at
 * most one single-char insert / delete / substitute, OR by a single
 * adjacent transposition (e.g. `sessoinId` vs `sessionId`).
 */
export function isWithinEditDistanceOne(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (la === lb) {
    // let justified: scan for diff position(s)
    let diff1 = -1;
    let diff2 = -1;
    for (let k = 0; k < la; k++) {
      if (a[k] !== b[k]) {
        if (diff1 === -1) diff1 = k;
        else if (diff2 === -1) diff2 = k;
        else return false;
      }
    }
    if (diff1 === -1) return true;
    if (diff2 === -1) return true;
    return diff2 === diff1 + 1 && a[diff1] === b[diff2] && a[diff2] === b[diff1];
  }
  // let justified: walk through shorter / longer string allowing one indel
  const [shorter, longer] = la < lb ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i++;
      j++;
      continue;
    }
    if (skipped) return false;
    skipped = true;
    j++;
  }
  return true;
}

export function unknownMatchFieldsFor(
  on: RuleEventType,
  match: Readonly<Record<string, unknown>>,
): readonly string[] {
  const keys = Object.keys(match);
  switch (on) {
    case "tool_call":
      return keys.filter((k) => {
        if (TOOL_CALL_CORE_FIELDS.includes(k as (typeof TOOL_CALL_CORE_FIELDS)[number])) {
          return false;
        }
        const exact = TOOL_CALL_CORE_LOWER.get(k.toLowerCase());
        if (exact !== undefined) return true;
        for (const core of TOOL_CALL_CORE_FIELDS) {
          if (isWithinEditDistanceOne(k, core)) return true;
        }
        return false;
      });
    case "turn_complete":
      return keys.filter((k) => !TURN_COMPLETE_FIELDS.has(k));
    case "session_start":
    case "session_end":
      return keys.filter((k) => !SESSION_FIELDS.has(k));
    default:
      return [];
  }
}

interface SkipToolAction {
  readonly type: string;
  readonly toolId?: string | undefined;
}

interface SkipToolRule {
  readonly on: RuleEventType;
  readonly match?: Readonly<Record<string, unknown>> | undefined;
  readonly condition?: unknown;
  readonly actions: readonly SkipToolAction[];
}

/**
 * Validates that a rule with `skip_tool` actions is statically safe:
 * the match clause must use only tool-level keys, and each action's
 * toolId must be reachable from `match.toolId`. See rule-schema.ts for
 * the full reasoning chain.
 */
export function isSkipToolRuleValid(r: SkipToolRule): boolean {
  const hasSkipTool = r.actions.some((a) => a.type === "skip_tool");
  if (!hasSkipTool || r.match === undefined) return true;
  if (r.on !== "tool_call") return true;

  const isWindowed = r.condition !== undefined;
  const SKIP_SAFE_KEYS = isWindowed
    ? new Set(["toolId", "ok", "blocked", "blockedByHook", "reason"])
    : new Set(["toolId"]);
  for (const k of Object.keys(r.match)) {
    if (!SKIP_SAFE_KEYS.has(k)) return false;
  }

  const skipActionToolIds = r.actions
    .filter((a): a is typeof a & { toolId: string } => a.type === "skip_tool")
    .map((a) => a.toolId);
  const matchToolId = (r.match as { toolId?: unknown }).toolId;
  for (const blocked of skipActionToolIds) {
    if (typeof matchToolId === "string") {
      if (matchToolId !== blocked) return false;
      continue;
    }
    if (Array.isArray(matchToolId)) {
      if (!matchToolId.includes(blocked)) return false;
      continue;
    }
    return false;
  }
  return true;
}
