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
 * is naturally escapedd — no sentinel-collision class of bug is reachable from
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
  const jsonText = extractOuterJsonObject(raw);
  if (jsonText === null) {
    return { ok: false, reason: "No JSON object found in model output" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `Output JSON parse failed: ${message}` };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "Output must be a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;

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
 * Locate the first balanced top-level `{ ... }` block, ignoring braces inside
 * JSON strings (with backslash-escaped awareness). Returns the substring or
 * `null` if no balanced object is found. We do not attempt to parse Markdown
 * code fences explicitly — finding a balanced JSON object is sufficient and
 * tolerates whatever framing the model adds around it.
 */
function extractOuterJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start === -1) return null;
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
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }
  return null;
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
