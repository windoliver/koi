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
  // Stack of unclosed `{` indices outside JSON strings. Pop on matching
  // `}` to emit the balanced span. Each char is touched once and stack ops
  // are O(1), so total cost is O(n) regardless of brace density —
  // including the worst-case "all unmatched `{`" pattern where the stack
  // simply keeps growing and is discarded at end of input.
  const opens: number[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
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
      if (start === undefined) continue; // stray `}` in prose
      const span = raw.slice(start, i + 1);
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
