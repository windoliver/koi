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
 * Iterate `{` candidate spans until one parses as a JSON object claiming to
 * be the synthesis payload (has both `descriptor` and `code` keys). Once we
 * find a claimant, return it for full validation by the caller — even if
 * its inner shape is wrong, so the caller can emit a precise error. Spans
 * that fail to parse, or parse but lack the claim keys, are skipped: this
 * tolerates prose containing earlier `{...}` fragments before the payload.
 */
function findParseableJsonObject(
  raw: string,
):
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string } {
  let lastParseReason: string | null = null;
  let cursor = 0;
  while (cursor < raw.length) {
    const start = raw.indexOf("{", cursor);
    if (start === -1) break;
    const end = findBalancedClose(raw, start);
    if (end === -1) {
      // Unmatched `{` — could be prose like "Use {descriptor, code". Skip
      // past this brace and keep searching for a balanced span later in
      // the response rather than aborting the whole scan.
      cursor = start + 1;
      continue;
    }
    const span = raw.slice(start, end + 1);
    cursor = end + 1;
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
      return { ok: true, value: obj };
    }
  }
  if (lastParseReason !== null) {
    return { ok: false, reason: lastParseReason };
  }
  return { ok: false, reason: "No JSON object found in model output" };
}

function claimsToBeSynthesisPayload(obj: Record<string, unknown>): boolean {
  return Object.hasOwn(obj, "descriptor") && Object.hasOwn(obj, "code");
}

function findBalancedClose(raw: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
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
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
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
