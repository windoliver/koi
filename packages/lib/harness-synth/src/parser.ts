/**
 * Parse LLM synthesis output into a `(code, ToolDescriptor)` pair.
 *
 * Format expected (matches `prompts/synthesis.ts`):
 *
 *   ```json
 *   { "descriptor": { "name": "...", "description": "...", "inputSchema": {...} },
 *     "code": "...source code..." }
 *   ```
 *
 * A single JSON object is the entire payload. Code travels as a JSON string,
 * so any character (including `"`, backslashes, or HTML-like tag fragments)
 * is naturally escaped — no sentinel-collision class of bug is reachable from
 * the model's source-code output. Surrounding fenced-code markers, prose, or
 * whitespace are tolerated; the parser locates the outermost JSON object and
 * rejects anything else.
 */

import type { JsonObject, ToolDescriptor } from "@koi/core";

export interface ParsedOutput {
  readonly code: string;
  readonly descriptor: ToolDescriptor;
}

export type ParseResult =
  | { readonly ok: true; readonly value: ParsedOutput }
  | { readonly ok: false; readonly reason: string };

export function parseSynthesisOutput(raw: string, targetToolName: string): ParseResult {
  const candidate = findParseableJsonObject(raw);
  if (!candidate.ok) {
    return candidate;
  }
  const obj = candidate.value;

  if (typeof obj.code !== "string") {
    return { ok: false, reason: "Output.code must be a string" };
  }
  const code = obj.code.trim();
  if (code.length === 0) {
    return { ok: false, reason: "Output.code is empty" };
  }

  const descriptorResult = coerceDescriptor(obj.descriptor, targetToolName);
  if (!descriptorResult.ok) {
    return descriptorResult;
  }

  return { ok: true, value: { code, descriptor: descriptorResult.value } };
}

/**
 * Find exactly one claimant — a JSON object with both `descriptor` and
 * `code` keys — in the response. Multiple claimants are rejected as
 * ambiguous: a model that quotes an earlier example/attempt followed by
 * the real answer would otherwise let the parser pick the wrong one,
 * which is a trust-boundary failure (verifier runs against stale code,
 * an earlier passing object ships instead of the corrected answer).
 *
 * Spans that fail to parse or lack the claim keys are skipped — this
 * still tolerates prose framing around the single intended payload.
 */
/**
 * Single-pass linear-time scan that emits every top-level balanced `{...}`
 * span: walks `raw` once, tracking depth and JSON string context, and
 * records the start when depth goes 0→1 and the end when depth goes 1→0.
 * O(n) total regardless of how many braces appear, including the worst-
 * case "200 KB of unmatched `{`" pattern that would have been quadratic
 * under the old "restart from each `{`" approach.
 */
function findParseableJsonObject(
  raw: string,
):
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string } {
  let lastParseReason: string | null = null;
  const claimants: Record<string, unknown>[] = [];
  // Two-phase linear scan. Phase 1: walk once, push every `{` onto a
  // stack and pop on `}`, recording (start, end, afterDepth) for each
  // matched pair. Each char is touched once and stack ops are O(1).
  // Phase 2: parse only spans whose afterDepth equals the unclosed-prefix
  // count (i.e. outermost-matched relative to whatever `{`s were
  // abandoned at EOF). Those spans are pairwise non-overlapping, so the
  // sum of their lengths is at most O(n). Total cost stays linear even
  // on deeply nested or brace-heavy input.
  const opens: number[] = [];
  const matched: Array<{ start: number; end: number; afterDepth: number }> = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    // Quote tracking only matters INSIDE a candidate JSON object — outside
    // any `{`, double quotes are just prose. Treating them as JSON-string
    // delimiters in arbitrary prose let an unmatched `"` swallow the rest
    // of the response and discard a valid payload that followed.
    if (opens.length === 0) {
      inString = false;
      escaped = false;
      if (ch === "{") opens.push(i);
      // Stray `}` in prose at top-level: ignore.
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      opens.push(i);
    } else if (ch === "}") {
      const start = opens.pop();
      if (start === undefined) continue; // unreachable: opens.length > 0 above
      matched.push({ start, end: i, afterDepth: opens.length });
    }
  }
  // A matched span S is "outermost" iff no LATER matched span has a
  // strictly smaller afterDepth — that would mean a later `}` closed a
  // `{` deeper in the stack than S's, i.e. S is itself enclosed by a
  // wider matched span. Walk right-to-left tracking the running minimum
  // afterDepth and accept spans with afterDepth <= minRight. This both
  // (a) rejects nested spans inside a still-matched outer scope and
  // (b) accepts spans that complete BEFORE a trailing unmatched `{`,
  // which the previous "afterDepth == abandoned" rule discarded.
  const outermost = new Array<boolean>(matched.length).fill(false);
  let minRight = Number.POSITIVE_INFINITY;
  for (let i = matched.length - 1; i >= 0; i -= 1) {
    const m = matched[i];
    if (m === undefined) continue;
    if (m.afterDepth <= minRight) {
      outermost[i] = true;
      minRight = m.afterDepth;
    }
  }
  for (let i = 0; i < matched.length; i += 1) {
    if (!outermost[i]) continue;
    const m = matched[i];
    if (m === undefined) continue;
    const { start, end } = m;
    const span = raw.slice(start, end + 1);
    let parsed: unknown;
    try {
      parsed = JSON.parse(span);
    } catch (err: unknown) {
      lastParseReason = `Output JSON parse failed: ${err instanceof Error ? err.message : String(err)}`;
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }
    const obj = parsed as Record<string, unknown>;
    if (claimsToBeSynthesisPayload(obj)) {
      claimants.push(obj);
    }
  }
  if (claimants.length === 1) {
    return { ok: true, value: claimants[0] as Record<string, unknown> };
  }
  if (claimants.length > 1) {
    return {
      ok: false,
      reason: `Output contains ${claimants.length} claimant payloads (expected exactly 1)`,
    };
  }
  if (lastParseReason !== null) {
    return { ok: false, reason: lastParseReason };
  }
  return { ok: false, reason: "No JSON object found in model output" };
}

function claimsToBeSynthesisPayload(obj: Record<string, unknown>): boolean {
  return Object.hasOwn(obj, "descriptor") && Object.hasOwn(obj, "code");
}

function coerceDescriptor(
  value: unknown,
  targetToolName: string,
):
  | { readonly ok: true; readonly value: ToolDescriptor }
  | { readonly ok: false; readonly reason: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "Descriptor must be a JSON object" };
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.name !== "string") {
    return { ok: false, reason: "Descriptor.name must be a string" };
  }
  if (obj.name !== targetToolName) {
    return {
      ok: false,
      reason: `Descriptor.name "${obj.name}" does not match target "${targetToolName}"`,
    };
  }
  if (typeof obj.description !== "string") {
    return { ok: false, reason: "Descriptor.description must be a string" };
  }
  if (
    obj.inputSchema === null ||
    typeof obj.inputSchema !== "object" ||
    Array.isArray(obj.inputSchema)
  ) {
    return { ok: false, reason: "Descriptor.inputSchema must be a JSON object" };
  }
  const descriptor: ToolDescriptor = {
    name: obj.name,
    description: obj.description,
    inputSchema: obj.inputSchema as JsonObject,
  };
  return { ok: true, value: descriptor };
}
