/**
 * JSON code-fence tool call pattern.
 *
 * Matches: ```json\n{"name": "...", "arguments": {...}}\n``` (or unlabeled fences).
 *
 * Only fences whose body parses to JSON with both `name` (non-empty string) and
 * `arguments` (object) are treated as tool calls. Other fences are left untouched
 * in the remaining text — the model may have used them for code samples.
 */

import type { ParsedToolCall, RecoveryResult, ToolCallPattern } from "../types.js";
import { computeRemainingText } from "./remaining-text.js";

const JSON_FENCE_REGEX = /```(?:json)?\s*\n([\s\S]*?)\n\s*```/g;

function parseJsonFenceBody(raw: string): ParsedToolCall | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  // let justified: JSON.parse may throw on malformed input.
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (typeof record.name !== "string" || record.name.length === 0) return undefined;
  if (typeof record.arguments !== "object" || record.arguments === null) return undefined;
  return {
    toolName: record.name,
    arguments: record.arguments as ParsedToolCall["arguments"],
  };
}

export const jsonFencePattern: ToolCallPattern = {
  name: "json-fence",
  detect(text: string): RecoveryResult | undefined {
    const matches = [...text.matchAll(JSON_FENCE_REGEX)];
    if (matches.length === 0) return undefined;

    const toolCalls: ParsedToolCall[] = [];
    // Only matches that parse as tool calls are stripped from the remaining text;
    // unrelated JSON fences are preserved for the model's user-facing output.
    const toolCallMatches: RegExpExecArray[] = [];

    for (const match of matches) {
      const body = match[1];
      if (body === undefined) continue;
      const parsed = parseJsonFenceBody(body);
      if (parsed === undefined) continue;
      toolCalls.push(parsed);
      toolCallMatches.push(match);
    }

    if (toolCalls.length === 0) return undefined;

    return { toolCalls, remainingText: computeRemainingText(text, toolCallMatches) };
  },
};
