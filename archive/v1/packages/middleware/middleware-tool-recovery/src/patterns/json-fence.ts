/**
 * JSON fence tool call pattern.
 *
 * Matches: ```json\n{"name": "...", "arguments": {...}}\n```
 * Also matches fences without the `json` tag.
 */

import type { ParsedToolCall, RecoveryResult, ToolCallPattern } from "../types.js";
import { computeRemainingText } from "./remaining-text.js";

const JSON_FENCE_REGEX = /```(?:json)?\s*\n([\s\S]*?)\n\s*```/g;

function parseJsonFenceBody(raw: string): ParsedToolCall | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  // let justified: JSON.parse may throw on malformed input
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  // Must have a "name" field to be considered a tool call
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
    // Track which matches are tool calls for remaining text computation
    const toolCallMatches: RegExpExecArray[] = [];

    for (const match of matches) {
      const body = match[1];
      if (body === undefined) continue;
      const parsed = parseJsonFenceBody(body);
      // Non-tool-call JSON fences are skipped (not an error)
      if (parsed === undefined) continue;
      toolCalls.push(parsed);
      toolCallMatches.push(match);
    }

    if (toolCalls.length === 0) return undefined;

    return { toolCalls, remainingText: computeRemainingText(text, toolCallMatches) };
  },
};
