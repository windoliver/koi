/**
 * Tool descriptors and dispatch for the auto-virtualization middleware.
 *
 * These tools are injected into ModelRequest.tools when content is
 * virtualized. The model uses them alongside its existing tools to
 * access virtualized content without it ever entering the context window.
 *
 * All tool names use the `rlm_` prefix to avoid collisions with
 * agent-defined tools.
 */

import type { JsonObject } from "@koi/core";
import type { InputStore } from "./input-store.js";
import type { RlmToolDescriptor, RlmToolResult } from "./tools.js";
import { MAX_EXAMINE_LENGTH } from "./types.js";

// ---------------------------------------------------------------------------
// Store registry (per-session, managed by the middleware)
// ---------------------------------------------------------------------------

export interface VirtualStoreRegistry {
  readonly get: (storeId: string) => InputStore | undefined;
  readonly latest: () => InputStore | undefined;
  readonly latestId: () => string | undefined;
  readonly list: () => readonly string[];
}

// ---------------------------------------------------------------------------
// Tool descriptors
// ---------------------------------------------------------------------------

export const RLM_EXAMINE_NAME = "rlm_examine" as const;
export const RLM_CHUNK_NAME = "rlm_chunk" as const;
export const RLM_INPUT_INFO_NAME = "rlm_input_info" as const;

export const RLM_EXAMINE_DESCRIPTOR: RlmToolDescriptor = {
  name: RLM_EXAMINE_NAME,
  description:
    `Read a slice of virtualized content. Returns the raw text from offset to offset+length. ` +
    `Max ${String(MAX_EXAMINE_LENGTH)} chars per call. ` +
    `To read all content: set offset=0, length=<sizeBytes from stub>. ` +
    `For large content, read incrementally with different offset values. ` +
    `This is the ONLY way to access virtualized content — re-reading the file will return the same stub.`,
  inputSchema: {
    type: "object",
    properties: {
      offset: { type: "number", description: "Character offset to start reading from." },
      length: {
        type: "number",
        description: `Number of characters to read. Max ${String(MAX_EXAMINE_LENGTH)}.`,
      },
      storeId: {
        type: "string",
        description: "ID of the virtualized store (e.g. 'v0'). Defaults to most recent.",
      },
    },
    required: ["offset", "length"],
    additionalProperties: false,
  },
};

export const RLM_CHUNK_DESCRIPTOR: RlmToolDescriptor = {
  name: RLM_CHUNK_NAME,
  description:
    "Returns metadata-only chunk descriptors (index, offset, length, preview) for a virtualized input. " +
    "Use rlm_examine to read actual content.",
  inputSchema: {
    type: "object",
    properties: {
      start_index: { type: "number", description: "Start chunk index (inclusive). Default: 0." },
      end_index: {
        type: "number",
        description: "End chunk index (inclusive). Default: last chunk.",
      },
      storeId: {
        type: "string",
        description: "ID of the virtualized store. Defaults to most recent.",
      },
    },
    additionalProperties: false,
  },
};

export const RLM_INPUT_INFO_DESCRIPTOR: RlmToolDescriptor = {
  name: RLM_INPUT_INFO_NAME,
  description:
    "Returns metadata about a virtualized input: format, size, token estimate, " +
    "chunk count, structure hints, and a preview.",
  inputSchema: {
    type: "object",
    properties: {
      storeId: {
        type: "string",
        description: "ID of the virtualized store. Defaults to most recent.",
      },
    },
    additionalProperties: false,
  },
};

export const ALL_VIRTUALIZE_DESCRIPTORS: readonly RlmToolDescriptor[] = [
  RLM_EXAMINE_DESCRIPTOR,
  RLM_CHUNK_DESCRIPTOR,
  RLM_INPUT_INFO_DESCRIPTOR,
];

export const VIRTUALIZE_TOOL_NAMES: ReadonlySet<string> = new Set([
  RLM_EXAMINE_NAME,
  RLM_CHUNK_NAME,
  RLM_INPUT_INFO_NAME,
]);

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

function resolveStore(
  registry: VirtualStoreRegistry,
  args: JsonObject,
): InputStore | RlmToolResult {
  const storeId = typeof args.storeId === "string" ? args.storeId : undefined;
  const store = storeId !== undefined ? registry.get(storeId) : registry.latest();
  if (store === undefined) {
    const available = registry.list();
    return {
      output:
        available.length === 0
          ? "Error: no virtualized inputs available."
          : `Error: store "${storeId ?? ""}" not found. Available: ${available.join(", ")}`,
      isError: true,
    };
  }
  return store;
}

function isError(result: InputStore | RlmToolResult): result is RlmToolResult {
  return "isError" in result;
}

/** Parse a numeric arg that may arrive as a string (common with LLM tool calls). */
function parseNumericArg(value: unknown, fallback: number): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return fallback;
}

export function dispatchExamine(registry: VirtualStoreRegistry, args: JsonObject): RlmToolResult {
  const storeOrError = resolveStore(registry, args);
  if (isError(storeOrError)) return storeOrError;
  const store = storeOrError;

  const offset = parseNumericArg(args.offset, 0);
  const length = parseNumericArg(args.length, 2000);

  if (offset < 0) return { output: "Error: offset must be >= 0.", isError: true };
  if (length > MAX_EXAMINE_LENGTH) {
    return { output: `Error: length must be <= ${String(MAX_EXAMINE_LENGTH)}.`, isError: true };
  }
  if (offset > store.length)
    return { output: "Error: offset exceeds input length.", isError: true };

  return { output: store.examine(offset, length), isError: false };
}

export function dispatchChunk(registry: VirtualStoreRegistry, args: JsonObject): RlmToolResult {
  const storeOrError = resolveStore(registry, args);
  if (isError(storeOrError)) return storeOrError;
  const store = storeOrError;

  const meta = store.metadata();
  const start = parseNumericArg(args.start_index, 0);
  const end = parseNumericArg(args.end_index, meta.totalChunks - 1);

  if (start > end) return { output: "Error: start_index must be <= end_index.", isError: true };

  return { output: store.chunkDescriptors(start, end), isError: false };
}

export function dispatchInputInfo(registry: VirtualStoreRegistry, args: JsonObject): RlmToolResult {
  const storeOrError = resolveStore(registry, args);
  if (isError(storeOrError)) return storeOrError;

  return { output: storeOrError.metadata(), isError: false };
}
