/**
 * Parse LLM output into structured middleware code + descriptor.
 *
 * Extracts TypeScript code blocks from LLM responses and validates
 * the basic structural requirements.
 */

import type { ToolDescriptor } from "@koi/core";

export interface ParsedOutput {
  readonly code: string;
  readonly descriptor: ToolDescriptor;
}

export type ParseResult =
  | { readonly ok: true; readonly value: ParsedOutput }
  | { readonly ok: false; readonly reason: string };

/**
 * Extract the first TypeScript/JavaScript code block from LLM output.
 * Supports ```typescript, ```ts, and bare ``` fences.
 */
function extractCodeBlock(raw: string): string | null {
  const pattern = /```(?:typescript|ts|javascript|js)?\s*\n([\s\S]*?)```/;
  const match = pattern.exec(raw);
  return match?.[1]?.trim() ?? null;
}

/**
 * Validate that the code contains the expected exports.
 * Light structural check — forge-verifier handles deep validation.
 */
function validateStructure(code: string): string | null {
  if (!code.includes("createMiddleware")) {
    return "Missing required export: createMiddleware";
  }
  if (!code.includes("wrapToolCall")) {
    return "Missing required hook: wrapToolCall";
  }
  return null;
}

/** Extract the middleware name from the code (if present). */
function extractName(code: string, fallbackToolName: string): string {
  const nameMatch = /name:\s*["'`]([^"'`]+)["'`]/.exec(code);
  return nameMatch?.[1] ?? `harness-${fallbackToolName}`;
}

/**
 * Parse raw LLM output into structured code + descriptor.
 *
 * Returns a Result — no exceptions for expected failures.
 */
export function parseSynthesisOutput(raw: string, targetToolName: string): ParseResult {
  if (raw.trim().length === 0) {
    return { ok: false, reason: "Empty LLM response" };
  }

  const code = extractCodeBlock(raw);
  if (code === null) {
    return { ok: false, reason: "No code block found in LLM response" };
  }

  const structureError = validateStructure(code);
  if (structureError !== null) {
    return { ok: false, reason: structureError };
  }

  const name = extractName(code, targetToolName);

  const descriptor: ToolDescriptor = {
    name,
    description: `Auto-synthesized harness middleware for ${targetToolName}. Validates tool call parameters to prevent observed failure patterns.`,
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  };

  return { ok: true, value: { code, descriptor } };
}
