/**
 * Ask-guide tool factory — creates a Tool that queries knowledge within a token budget.
 *
 * Follows the same factory pattern as @koi/tool-ask-user but optimized for
 * context retrieval rather than user elicitation.
 */

import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import type { JsonObject } from "@koi/core/common";
import type { Tool, ToolExecuteOptions } from "@koi/core/ecs";
import { estimateTokens } from "@koi/token-estimator";
import { validateWith } from "@koi/validation";
import { z } from "zod";
import {
  ASK_GUIDE_TOOL_DESCRIPTOR,
  type AskGuideConfig,
  DEFAULT_MAX_RESULTS,
  DEFAULT_MAX_TOKENS,
  type GuideSearchResult,
} from "./types.js";

const questionSchema = z.object({
  question: z.string().min(1, "Question must not be empty"),
});

/**
 * Creates the `ask_guide` tool for knowledge retrieval within a token budget.
 *
 * Flow:
 * 1. Validate input: non-empty question string
 * 2. Call config.search() to get relevant results
 * 3. Accumulate results within maxTokens budget
 * 4. Return structured response with truncation indicator
 */
export function createAskGuideTool(config: AskGuideConfig): Tool {
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
  const maxResults = config.maxResults ?? DEFAULT_MAX_RESULTS;

  return {
    descriptor: ASK_GUIDE_TOOL_DESCRIPTOR,
    origin: "primordial",
    policy: DEFAULT_UNSANDBOXED_POLICY,

    async execute(args: JsonObject, _options?: ToolExecuteOptions): Promise<unknown> {
      // 1. Validate input
      const inputResult = validateWith(questionSchema, args, "ask_guide input validation failed");
      if (!inputResult.ok) {
        return { error: inputResult.error.message, code: "VALIDATION" };
      }

      const { question } = inputResult.value;

      // 2. Call search
      let searchResults: readonly GuideSearchResult[]; // let: assigned in try, used after catch
      try {
        searchResults = await config.search(question, maxResults);
      } catch (e: unknown) {
        if (e instanceof DOMException && (e.name === "AbortError" || e.name === "TimeoutError")) {
          return { error: "Search timed out", code: "TIMEOUT" };
        }
        const message = e instanceof Error ? e.message : "Unknown search error";
        return { error: message, code: "EXTERNAL" };
      }

      if (searchResults.length === 0) {
        return { results: [], totalFound: 0, truncated: false };
      }

      // 3. Accumulate results within token budget
      const accumulated: GuideSearchResult[] = [];
      let usedTokens = 0; // let: accumulator for token budget
      let truncated = false; // let: flag set when budget exceeded

      for (const result of searchResults) {
        const resultTokens = estimateTokens(`${result.title}\n${result.content}`);
        if (usedTokens + resultTokens > maxTokens && accumulated.length > 0) {
          truncated = true;
          break;
        }
        accumulated.push(result);
        usedTokens += resultTokens;
      }

      // Flag budget exceeded even when the first result alone overflows
      if (usedTokens > maxTokens) {
        truncated = true;
      }

      return {
        results: accumulated,
        totalFound: searchResults.length,
        truncated,
      };
    },
  };
}
