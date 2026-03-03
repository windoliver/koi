/**
 * Hermes tool call pattern.
 *
 * Matches: <tool_call>{"name": "...", "arguments": {...}}</tool_call>
 */

import type { ParsedToolCall, RecoveryResult, ToolCallPattern } from "../types.js";
import { computeRemainingText } from "./remaining-text.js";

const HERMES_REGEX = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;

function parseHermesBody(raw: string): ParsedToolCall | undefined {
  // let justified: JSON.parse may throw on malformed input
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
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

export const hermesPattern: ToolCallPattern = {
  name: "hermes",
  detect(text: string): RecoveryResult | undefined {
    const matches = [...text.matchAll(HERMES_REGEX)];
    if (matches.length === 0) return undefined;

    const toolCalls: ParsedToolCall[] = [];

    for (const match of matches) {
      const body = match[1];
      if (body === undefined) continue;
      const parsed = parseHermesBody(body);
      if (parsed === undefined) return undefined;
      toolCalls.push(parsed);
    }

    if (toolCalls.length === 0) return undefined;

    return { toolCalls, remainingText: computeRemainingText(text, matches) };
  },
};
