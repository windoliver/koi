/**
 * Tool descriptor for the `rlm_process` tool.
 *
 * Extracted as a standalone constant so both the middleware (for injection)
 * and the bundle (for ECS registration) can reference it without coupling.
 */

import type { JsonObject } from "@koi/core/common";

/** Tool name constant — used for both injection and interception. */
export const RLM_PROCESS_TOOL_NAME: "rlm_process" = "rlm_process";

// ---------------------------------------------------------------------------
// Descriptor shape
// ---------------------------------------------------------------------------

interface RlmProcessDescriptor {
  readonly name: "rlm_process";
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly tags: readonly ["rlm", "large-input", "recursive"];
}

/**
 * Descriptor for the `rlm_process` tool injected into model requests.
 *
 * This is the external-facing tool that the calling model invokes when it
 * encounters input too large for its context window. The middleware
 * intercepts this call and runs the REPL loop internally.
 */
export const RLM_PROCESS_DESCRIPTOR: RlmProcessDescriptor = {
  name: RLM_PROCESS_TOOL_NAME,
  description:
    "Analyze input that is too large to fit in your context window. " +
    "This tool virtualizes the input and uses an autonomous sub-agent that " +
    "programmatically examines, chunks, and queries the content without " +
    "loading it all into context at once. " +
    "Supports: JSON, markdown, CSV, code, and plaintext. " +
    "Use this when: (1) you receive a document, dataset, or codebase too " +
    "large to read directly, (2) you are told the input is very large, or " +
    "(3) you need to search/summarize/extract from a large body of text. " +
    "Provide a specific question — vague questions produce vague answers.",
  inputSchema: {
    type: "object",
    properties: {
      input: {
        type: "string",
        description:
          "The large input text to process. " +
          "Can be JSON, markdown, CSV, code, or plaintext. " +
          "No size limit beyond the configured maximum (default: 100 MB).",
      },
      question: {
        type: "string",
        description:
          "A specific question or task about the input. " +
          "Good: 'List all functions that call the database.' " +
          "Bad: 'Summarize this.' " +
          "The more precise the question, the better the result.",
      },
    },
    required: ["input", "question"],
  },
  tags: ["rlm", "large-input", "recursive"],
};
