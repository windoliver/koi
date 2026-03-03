/**
 * RLM tool factories — 7 tools for the REPL loop.
 *
 * Each factory returns a Tool-like object with a name and execute function.
 * These are internal to the adapter; they are NOT registered as Koi Tools
 * via the resolver. Instead, the adapter injects them as tool descriptors
 * into the model request and dispatches tool calls locally.
 */

import type { JsonObject, ModelHandler } from "@koi/core";
import type { InputStore } from "./input-store.js";
import type { Semaphore } from "./semaphore.js";
import type { TokenTracker } from "./token-tracker.js";
import type { RlmSpawnRequest, RlmSpawnResult } from "./types.js";
import { MAX_BATCH_PROMPTS, MAX_EXAMINE_LENGTH } from "./types.js";

// ---------------------------------------------------------------------------
// Tool result type
// ---------------------------------------------------------------------------

export interface RlmToolResult {
  readonly output: unknown;
  readonly isError: boolean;
}

// ---------------------------------------------------------------------------
// Tool descriptor shapes (for model request injection)
// ---------------------------------------------------------------------------

export interface RlmToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
}

// ---------------------------------------------------------------------------
// input_info
// ---------------------------------------------------------------------------

export interface InputInfoDeps {
  readonly store: InputStore;
}

export function createInputInfoTool(deps: InputInfoDeps): {
  readonly descriptor: RlmToolDescriptor;
  readonly execute: () => RlmToolResult;
} {
  return {
    descriptor: {
      name: "input_info",
      description:
        "Returns metadata about the virtualized input: format, size, token estimate, " +
        "chunk count, structure hints, and a preview.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    execute(): RlmToolResult {
      return { output: deps.store.metadata(), isError: false };
    },
  };
}

// ---------------------------------------------------------------------------
// examine
// ---------------------------------------------------------------------------

export interface ExamineDeps {
  readonly store: InputStore;
}

export function createExamineTool(deps: ExamineDeps): {
  readonly descriptor: RlmToolDescriptor;
  readonly execute: (args: JsonObject) => RlmToolResult;
} {
  return {
    descriptor: {
      name: "examine",
      description: `Read a slice of the virtualized input. Max ${String(MAX_EXAMINE_LENGTH)} chars per call.`,
      inputSchema: {
        type: "object",
        properties: {
          offset: { type: "number", description: "Character offset to start reading from." },
          length: {
            type: "number",
            description: `Number of characters to read. Max ${String(MAX_EXAMINE_LENGTH)}.`,
          },
        },
        required: ["offset", "length"],
        additionalProperties: false,
      },
    },
    execute(args: JsonObject): RlmToolResult {
      const offset = args.offset;
      const length = args.length;

      if (typeof offset !== "number" || typeof length !== "number") {
        return { output: "Error: offset and length must be numbers.", isError: true };
      }
      if (offset < 0) {
        return { output: "Error: offset must be >= 0.", isError: true };
      }
      if (length > MAX_EXAMINE_LENGTH) {
        return {
          output: `Error: length must be <= ${String(MAX_EXAMINE_LENGTH)}.`,
          isError: true,
        };
      }
      if (offset > deps.store.length) {
        return { output: "Error: offset exceeds input length.", isError: true };
      }

      return { output: deps.store.examine(offset, length), isError: false };
    },
  };
}

// ---------------------------------------------------------------------------
// chunk
// ---------------------------------------------------------------------------

export interface ChunkDeps {
  readonly store: InputStore;
}

export function createChunkTool(deps: ChunkDeps): {
  readonly descriptor: RlmToolDescriptor;
  readonly execute: (args: JsonObject) => RlmToolResult;
} {
  return {
    descriptor: {
      name: "chunk",
      description:
        "Returns metadata-only chunk descriptors (index, offset, length, preview). " +
        "Use examine() to read actual content.",
      inputSchema: {
        type: "object",
        properties: {
          start_index: {
            type: "number",
            description: "Start chunk index (inclusive). Default: 0.",
          },
          end_index: {
            type: "number",
            description: "End chunk index (inclusive). Default: last chunk.",
          },
        },
        additionalProperties: false,
      },
    },
    execute(args: JsonObject): RlmToolResult {
      const meta = deps.store.metadata();
      const startRaw = args.start_index;
      const endRaw = args.end_index;

      const start = typeof startRaw === "number" ? startRaw : 0;
      const end = typeof endRaw === "number" ? endRaw : meta.totalChunks - 1;

      if (start > end) {
        return { output: "Error: start_index must be <= end_index.", isError: true };
      }

      return { output: deps.store.chunkDescriptors(start, end), isError: false };
    },
  };
}

// ---------------------------------------------------------------------------
// llm_query
// ---------------------------------------------------------------------------

export interface LlmQueryDeps {
  readonly modelCall: ModelHandler;
  readonly tracker: TokenTracker;
  readonly model?: string | undefined;
}

export function createLlmQueryTool(deps: LlmQueryDeps): {
  readonly descriptor: RlmToolDescriptor;
  readonly execute: (args: JsonObject) => Promise<RlmToolResult>;
} {
  return {
    descriptor: {
      name: "llm_query",
      description:
        "Make a single LLM call with the given prompt. Returns the model response as a string.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "The prompt to send to the model." },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
    },
    async execute(args: JsonObject): Promise<RlmToolResult> {
      const prompt = args.prompt;
      if (typeof prompt !== "string" || prompt.length === 0) {
        return { output: "Error: prompt must be a non-empty string.", isError: true };
      }

      try {
        deps.tracker.add(prompt);
        const response = await deps.modelCall({
          messages: [
            {
              content: [{ kind: "text" as const, text: prompt }],
              senderId: "user",
              timestamp: Date.now(),
            },
          ],
          ...(deps.model !== undefined ? { model: deps.model } : {}),
        });
        deps.tracker.add(response.content);
        if (response.usage !== undefined) {
          deps.tracker.addTokens(response.usage.inputTokens + response.usage.outputTokens);
        }
        return { output: response.content, isError: false };
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        return { output: `Error: LLM call failed — ${message}`, isError: true };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// llm_query_batched
// ---------------------------------------------------------------------------

export interface LlmQueryBatchedDeps {
  readonly modelCall: ModelHandler;
  readonly tracker: TokenTracker;
  readonly semaphore: Semaphore;
  readonly model?: string | undefined;
}

export function createLlmQueryBatchedTool(deps: LlmQueryBatchedDeps): {
  readonly descriptor: RlmToolDescriptor;
  readonly execute: (args: JsonObject) => Promise<RlmToolResult>;
} {
  return {
    descriptor: {
      name: "llm_query_batched",
      description: `Run multiple LLM calls concurrently. Max ${String(MAX_BATCH_PROMPTS)} prompts per call.`,
      inputSchema: {
        type: "object",
        properties: {
          prompts: {
            type: "array",
            items: { type: "string" },
            description: "Array of prompts to send concurrently.",
          },
        },
        required: ["prompts"],
        additionalProperties: false,
      },
    },
    async execute(args: JsonObject): Promise<RlmToolResult> {
      const prompts = args.prompts;
      if (!Array.isArray(prompts) || prompts.length === 0) {
        return { output: "Error: prompts must be a non-empty array.", isError: true };
      }
      if (prompts.length > MAX_BATCH_PROMPTS) {
        return {
          output: `Error: max ${String(MAX_BATCH_PROMPTS)} prompts per batch.`,
          isError: true,
        };
      }
      if (!prompts.every((p): p is string => typeof p === "string")) {
        return { output: "Error: all prompts must be strings.", isError: true };
      }

      const results = await Promise.allSettled(
        prompts.map((prompt) =>
          deps.semaphore.run(async () => {
            deps.tracker.add(prompt);
            const response = await deps.modelCall({
              messages: [
                {
                  content: [{ kind: "text" as const, text: prompt }],
                  senderId: "user",
                  timestamp: Date.now(),
                },
              ],
              ...(deps.model !== undefined ? { model: deps.model } : {}),
            });
            deps.tracker.add(response.content);
            return response.content;
          }),
        ),
      );

      const outputs = results.map((r) =>
        r.status === "fulfilled"
          ? r.value
          : `Error: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
      );

      return { output: outputs, isError: false };
    },
  };
}

// ---------------------------------------------------------------------------
// rlm_query
// ---------------------------------------------------------------------------

export interface RlmQueryDeps {
  readonly spawnRlmChild?: ((req: RlmSpawnRequest) => Promise<RlmSpawnResult>) | undefined;
  readonly tracker: TokenTracker;
  readonly depth: number;
  readonly startTime: number;
  readonly timeBudgetMs: number;
}

export function createRlmQueryTool(deps: RlmQueryDeps): {
  readonly descriptor: RlmToolDescriptor;
  readonly execute: (args: JsonObject) => Promise<RlmToolResult>;
} {
  return {
    descriptor: {
      name: "rlm_query",
      description:
        "Spawn a child RLM agent to recursively process a sub-input. " +
        "The child inherits remaining budget and timeout.",
      inputSchema: {
        type: "object",
        properties: {
          input: {
            type: "string",
            description: "The input text for the child RLM agent.",
          },
        },
        required: ["input"],
        additionalProperties: false,
      },
    },
    async execute(args: JsonObject): Promise<RlmToolResult> {
      if (deps.spawnRlmChild === undefined) {
        return {
          output: "Error: rlm_query is not available — no spawnRlmChild callback configured.",
          isError: true,
        };
      }

      const input = args.input;
      if (typeof input !== "string" || input.length === 0) {
        return { output: "Error: input must be a non-empty string.", isError: true };
      }

      try {
        const elapsed = Date.now() - deps.startTime;
        const remainingTimeMs = Math.max(0, deps.timeBudgetMs - elapsed);

        const result = await deps.spawnRlmChild({
          input,
          depth: deps.depth + 1,
          remainingTokenBudget: deps.tracker.remaining(),
          remainingTimeMs,
        });

        deps.tracker.addTokens(result.tokensUsed);
        return { output: result.answer, isError: false };
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        return { output: `Error: child RLM failed — ${message}`, isError: true };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// FINAL
// ---------------------------------------------------------------------------

export interface FinalDeps {
  readonly onFinal: (answer: string) => void;
}

export function createFinalTool(deps: FinalDeps): {
  readonly descriptor: RlmToolDescriptor;
  readonly execute: (args: JsonObject) => RlmToolResult;
} {
  return {
    descriptor: {
      name: "FINAL",
      description:
        "Terminates the REPL loop with the given answer. " +
        "Call this when you have determined the final answer.",
      inputSchema: {
        type: "object",
        properties: {
          answer: { type: "string", description: "The final answer." },
        },
        required: ["answer"],
        additionalProperties: false,
      },
    },
    execute(args: JsonObject): RlmToolResult {
      const answer = args.answer;
      if (typeof answer !== "string") {
        return { output: "Error: answer must be a string.", isError: true };
      }
      if (answer.length === 0) {
        return { output: "Error: answer must not be empty.", isError: true };
      }

      deps.onFinal(answer);
      return { output: `Final answer recorded (${String(answer.length)} chars).`, isError: false };
    },
  };
}

// ---------------------------------------------------------------------------
// All tool descriptors (for model request injection)
// ---------------------------------------------------------------------------

export function getAllToolDescriptors(tools: {
  readonly inputInfo: { readonly descriptor: RlmToolDescriptor };
  readonly examine: { readonly descriptor: RlmToolDescriptor };
  readonly chunk: { readonly descriptor: RlmToolDescriptor };
  readonly llmQuery: { readonly descriptor: RlmToolDescriptor };
  readonly llmQueryBatched: { readonly descriptor: RlmToolDescriptor };
  readonly rlmQuery: { readonly descriptor: RlmToolDescriptor };
  readonly final: { readonly descriptor: RlmToolDescriptor };
}): readonly RlmToolDescriptor[] {
  return [
    tools.inputInfo.descriptor,
    tools.examine.descriptor,
    tools.chunk.descriptor,
    tools.llmQuery.descriptor,
    tools.llmQueryBatched.descriptor,
    tools.rlmQuery.descriptor,
    tools.final.descriptor,
  ];
}
