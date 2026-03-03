/**
 * Types for the ask-guide tool.
 *
 * L2 — imports from @koi/core only.
 */

import type { ToolDescriptor } from "@koi/core/ecs";

/** A single search result returned by the guide's search function. */
export interface GuideSearchResult {
  /** Title or heading of the matched content. */
  readonly title: string;
  /** The matched content text. */
  readonly content: string;
  /** Optional source path or identifier. */
  readonly source?: string;
}

/** Default token budget for guide responses. */
export const DEFAULT_MAX_TOKENS = 500;

/** Default maximum number of search results to request. */
export const DEFAULT_MAX_RESULTS = 10;

/**
 * Configuration for the ask-guide tool.
 *
 * The `search` callback is the sole extension point — consumers wire up
 * their own SearchProvider, Retriever, or custom search implementation.
 */
export interface AskGuideConfig {
  /**
   * Callback that searches for relevant content given a query.
   * Returns an ordered list of results (best match first).
   */
  readonly search: (query: string, maxResults?: number) => Promise<readonly GuideSearchResult[]>;
  /** Maximum token budget for the response. Default: 500. */
  readonly maxTokens?: number | undefined;
  /** Maximum search results to request. Default: 10. */
  readonly maxResults?: number | undefined;
}

/** Tool descriptor exposed to the model for the ask_guide tool. */
export const ASK_GUIDE_TOOL_DESCRIPTOR: ToolDescriptor = {
  name: "ask_guide",
  description:
    "Ask a question about skills, docs, or knowledge. Returns concise, relevant context within a token budget. Use when you need information from the knowledge base without flooding your context.",
  inputSchema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The question to ask. Should be specific and focused for best results.",
      },
    },
    required: ["question"],
  },
};
