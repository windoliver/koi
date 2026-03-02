/**
 * RLM as a Tool — wraps the RLM engine adapter as a Koi Tool so any agent
 * can invoke it to process large inputs that exceed the context window.
 */

import type { EngineOutput, JsonObject, Tool, ToolExecuteOptions } from "@koi/core";
import { createRlmAdapter } from "./adapter.js";
import type { RlmConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Configuration for `createRlmTool()`.
 *
 * A subset of `RlmConfig` — excludes adapter-only fields (`modelStream`,
 * `toolCall`, `previewLength`, `compactionThreshold`, `depth`) that are
 * irrelevant when the RLM is used as a tool rather than a standalone engine.
 */
export type RlmToolConfig = Omit<
  RlmConfig,
  "modelStream" | "toolCall" | "previewLength" | "compactionThreshold" | "depth"
>;

// ---------------------------------------------------------------------------
// Tool descriptor
// ---------------------------------------------------------------------------

const RLM_TOOL_DESCRIPTOR = {
  name: "rlm_process",
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
  } satisfies JsonObject,
  tags: ["rlm", "large-input", "recursive"],
} as const;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a Koi `Tool` that wraps the RLM engine adapter.
 *
 * Any agent can include this tool in its toolbox to process inputs that are
 * too large for its own context window. The tool creates a fresh RLM adapter
 * per invocation, streams it to completion, and returns the final answer.
 */
export function createRlmTool(config: RlmToolConfig): Tool {
  return {
    descriptor: RLM_TOOL_DESCRIPTOR,
    trustTier: "verified",

    execute: async (args: JsonObject, options?: ToolExecuteOptions): Promise<unknown> => {
      // --- Validate inputs ------------------------------------------------
      const { input, question } = args;

      if (input === undefined || input === null) {
        return { error: "Missing required field: input", code: "RLM_ERROR" };
      }
      if (typeof input !== "string") {
        return { error: "Field 'input' must be a string", code: "RLM_ERROR" };
      }
      if (input.length === 0) {
        return { error: "Field 'input' must not be empty", code: "RLM_ERROR" };
      }

      if (question === undefined || question === null) {
        return { error: "Missing required field: question", code: "RLM_ERROR" };
      }
      if (typeof question !== "string") {
        return { error: "Field 'question' must be a string", code: "RLM_ERROR" };
      }
      if (question.length === 0) {
        return { error: "Field 'question' must not be empty", code: "RLM_ERROR" };
      }

      // --- Build adapter --------------------------------------------------
      const adapter = createRlmAdapter({
        modelCall: config.modelCall,
        subCallModel: config.subCallModel,
        rootModel: config.rootModel,
        maxIterations: config.maxIterations,
        maxInputBytes: config.maxInputBytes,
        chunkSize: config.chunkSize,
        contextWindowTokens: config.contextWindowTokens,
        maxConcurrency: config.maxConcurrency,
        spawnRlmChild: config.spawnRlmChild,
      });

      // --- Wire abort signal ----------------------------------------------
      const signal = options?.signal;
      if (signal?.aborted === true) {
        await adapter.dispose?.();
        return { error: "Aborted before execution", code: "RLM_ERROR" };
      }

      // Abort listener delegates to finally block via dispose — the
      // finally block is the single cleanup path for both normal and
      // aborted flows.
      signal?.addEventListener("abort", () => void adapter.dispose?.(), { once: true });

      // --- Run adapter and collect answer ---------------------------------
      try {
        const inputWithQuestion = `Question: ${question}\n\nInput follows.\n${input}`;

        // let: holds the final done output
        let doneOutput: EngineOutput | undefined;

        for await (const event of adapter.stream({ kind: "text", text: inputWithQuestion })) {
          if (event.kind === "done") {
            doneOutput = event.output;
          }
        }

        if (doneOutput === undefined) {
          return { error: "Adapter completed without a done event", code: "RLM_ERROR" };
        }

        if (doneOutput.stopReason === "error") {
          const errorText = doneOutput.content
            .map((b) => (b.kind === "text" ? b.text : ""))
            .join("");
          return { error: errorText || "RLM processing failed", code: "RLM_ERROR" };
        }

        // Extract text from content blocks
        const answer = doneOutput.content.map((b) => (b.kind === "text" ? b.text : "")).join("");

        return answer;
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        return { error: `RLM execution failed: ${message}`, code: "RLM_ERROR" };
      } finally {
        await adapter.dispose?.();
      }
    },
  };
}
