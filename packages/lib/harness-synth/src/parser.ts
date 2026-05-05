/**
 * Parse LLM synthesis output into a `(code, ToolDescriptor)` pair.
 *
 * Format expected (matches `prompts/synthesis.ts`):
 *   <descriptor>{...JSON...}</descriptor>
 *   <code>...source...</code>
 *
 * Returns a discriminated `ParseResult` — never throws on malformed input.
 */

import type { JsonObject, ToolDescriptor } from "@koi/core";

export interface ParsedOutput {
  readonly code: string;
  readonly descriptor: ToolDescriptor;
}

export type ParseResult =
  | { readonly ok: true; readonly value: ParsedOutput }
  | { readonly ok: false; readonly reason: string };

const DESCRIPTOR_RE = /<descriptor>([\s\S]*?)<\/descriptor>/;
const CODE_RE = /<code>([\s\S]*?)<\/code>/;

export function parseSynthesisOutput(raw: string, targetToolName: string): ParseResult {
  const descriptorMatch = DESCRIPTOR_RE.exec(raw);
  if (!descriptorMatch || descriptorMatch[1] === undefined) {
    return { ok: false, reason: "Missing <descriptor> section in model output" };
  }
  const codeMatch = CODE_RE.exec(raw);
  if (!codeMatch || codeMatch[1] === undefined) {
    return { ok: false, reason: "Missing <code> section in model output" };
  }

  const code = codeMatch[1].trim();
  if (code.length === 0) {
    return { ok: false, reason: "<code> section is empty" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(descriptorMatch[1].trim());
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `Descriptor JSON parse failed: ${message}` };
  }

  const descriptorResult = coerceDescriptor(parsed, targetToolName);
  if (!descriptorResult.ok) {
    return descriptorResult;
  }

  return { ok: true, value: { code, descriptor: descriptorResult.value } };
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
