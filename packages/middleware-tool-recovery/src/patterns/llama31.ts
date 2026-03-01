/**
 * Llama 3.1 tool call pattern.
 *
 * Matches: <function=tool_name>{"key": "value"}</function>
 */

import type { ParsedToolCall, RecoveryResult, ToolCallPattern } from "../types.js";
import { computeRemainingText } from "./remaining-text.js";

const LLAMA31_REGEX = /<function=([^>]+)>([\s\S]*?)<\/function>/g;

function parseLlama31Body(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return {};
  // let justified: JSON.parse may throw on malformed input
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  return parsed as Record<string, unknown>;
}

export const llama31Pattern: ToolCallPattern = {
  name: "llama31",
  detect(text: string): RecoveryResult | undefined {
    const matches = [...text.matchAll(LLAMA31_REGEX)];
    if (matches.length === 0) return undefined;

    const toolCalls: ParsedToolCall[] = [];

    for (const match of matches) {
      const toolName = match[1];
      const body = match[2];
      if (toolName === undefined || body === undefined) continue;
      const args = parseLlama31Body(body);
      if (args === undefined) return undefined;
      toolCalls.push({
        toolName: toolName.trim(),
        arguments: args as ParsedToolCall["arguments"],
      });
    }

    if (toolCalls.length === 0) return undefined;

    return { toolCalls, remainingText: computeRemainingText(text, matches) };
  },
};
