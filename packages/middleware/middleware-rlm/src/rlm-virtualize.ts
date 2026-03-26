/**
 * RLM auto-virtualization middleware.
 *
 * Transparently intercepts oversized content in model requests and tool
 * responses, writing it to temp files and replacing it with compact stubs.
 * Injects access tools (rlm_examine, rlm_chunk, rlm_input_info) so the
 * model can read slices without the raw content entering its context window.
 *
 * Matches the ypi / RLM paper pattern: context is virtualized BEFORE the
 * model sees it. The model's normal engine loop handles the rest — no
 * separate REPL loop needed.
 *
 * Temp files persist on disk across session boundaries, enabling the
 * autonomous harness to resume sessions with virtualized content intact.
 *
 * Priority 250: runs before model-router, so it can intercept content early.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContentBlock, InboundMessage } from "@koi/core";
import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelRequest,
  ModelResponse,
  SessionContext,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core/middleware";
import { estimateTokens } from "@koi/token-estimator";
import type { InputStore } from "./input-store.js";
import { createInputStore } from "./input-store.js";
import type { VirtualStoreRegistry } from "./virtualize-tools.js";
import {
  ALL_VIRTUALIZE_DESCRIPTORS,
  dispatchChunk,
  dispatchExamine,
  dispatchInputInfo,
  RLM_CHUNK_NAME,
  RLM_EXAMINE_NAME,
  RLM_INPUT_INFO_NAME,
  VIRTUALIZE_TOOL_NAMES,
} from "./virtualize-tools.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_VIRTUALIZE_THRESHOLD = 20_000; // tokens (~80K chars)
const DEFAULT_VIRTUALIZE_CHUNK_SIZE = 4_000;
const DEFAULT_VIRTUALIZE_PREVIEW_LENGTH = 500;
const DEFAULT_VIRTUALIZE_PRIORITY = 250;

export interface RlmVirtualizeConfig {
  /** Token threshold for auto-virtualization. Default: 20,000. */
  readonly virtualizeThreshold?: number | undefined;
  /** Chunk size for InputStore. Default: 4,000. */
  readonly chunkSize?: number | undefined;
  /** Preview length for stubs. Default: 500. */
  readonly previewLength?: number | undefined;
  /** Middleware priority. Default: 250 (before model-router). */
  readonly priority?: number | undefined;
  /** Base directory for temp files. Default: os.tmpdir()/rlm. */
  readonly tempDir?: string | undefined;
  /** Audit event callback. Called when content is virtualized or evicted. */
  readonly onAudit?: ((event: RlmAuditEvent) => void) | undefined;
}

// ---------------------------------------------------------------------------
// Audit events
// ---------------------------------------------------------------------------

export type RlmAuditEvent =
  | {
      readonly kind: "virtualized";
      readonly virtualId: string;
      readonly source: string;
      readonly format: string;
      readonly sizeBytes: number;
      readonly estimatedTokens: number;
      readonly filePath: string;
      readonly sessionId: string;
      readonly timestamp: number;
    }
  | {
      readonly kind: "rehydrated";
      readonly virtualId: string;
      readonly filePath: string;
      readonly sessionId: string;
      readonly timestamp: number;
    }
  | {
      readonly kind: "evicted";
      readonly virtualId: string;
      readonly filePath: string;
      readonly sessionId: string;
      readonly timestamp: number;
    };

// ---------------------------------------------------------------------------
// Stub format
// ---------------------------------------------------------------------------

const STUB_MARKER = "[Virtualized input" as const;

function generateStub(
  virtualId: string,
  filePath: string,
  meta: {
    readonly format: string;
    readonly sizeBytes: number;
    readonly estimatedTokens: number;
    readonly totalChunks: number;
    readonly preview: string;
  },
): string {
  return (
    `${STUB_MARKER} ${virtualId}]\n` +
    `Format: ${meta.format} | Size: ${String(meta.sizeBytes)} bytes (~${String(meta.estimatedTokens)} tokens) | Chunks: ${String(meta.totalChunks)}\n` +
    `File: ${filePath}\n` +
    `Preview: ${meta.preview}\n` +
    `Use rlm_examine, rlm_chunk, rlm_input_info tools to access this content.`
  );
}

/** Parse a stub to extract virtualId and filePath. Returns undefined if not a stub. */
function parseStub(
  text: string,
): { readonly virtualId: string; readonly filePath: string } | undefined {
  if (!text.startsWith(STUB_MARKER)) return undefined;
  const idMatch = /\[Virtualized input (v\d+)\]/.exec(text);
  const fileMatch = /^File: (.+)$/m.exec(text);
  if (idMatch === null || fileMatch === null) return undefined;
  const id = idMatch[1];
  const fp = fileMatch[1];
  if (id === undefined || fp === undefined) return undefined;
  return { virtualId: id, filePath: fp };
}

// ---------------------------------------------------------------------------
// Per-session state
// ---------------------------------------------------------------------------

interface SessionState {
  readonly stores: Map<string, InputStore>;
  readonly filePaths: Map<string, string>;
  // let: counter for generating virtualIds
  nextId: number;
  readonly sessionDir: string;
}

function createRegistry(state: SessionState): VirtualStoreRegistry {
  return {
    get: (storeId: string) => state.stores.get(storeId),
    latest: () => {
      if (state.stores.size === 0) return undefined;
      const lastKey = `v${String(state.nextId - 1)}`;
      return state.stores.get(lastKey);
    },
    latestId: () => {
      if (state.stores.size === 0) return undefined;
      return `v${String(state.nextId - 1)}`;
    },
    list: () => [...state.stores.keys()],
  };
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Creates an auto-virtualization middleware.
 *
 * Scans model requests for oversized text content and tool outputs,
 * writes them to temp files, and replaces with stubs + access tools.
 */
export function createRlmVirtualizeMiddleware(config?: RlmVirtualizeConfig): KoiMiddleware {
  const threshold = config?.virtualizeThreshold ?? DEFAULT_VIRTUALIZE_THRESHOLD;
  const chunkSize = config?.chunkSize ?? DEFAULT_VIRTUALIZE_CHUNK_SIZE;
  const previewLength = config?.previewLength ?? DEFAULT_VIRTUALIZE_PREVIEW_LENGTH;
  const priority = config?.priority ?? DEFAULT_VIRTUALIZE_PRIORITY;
  const baseTempDir = config?.tempDir ?? join(tmpdir(), "rlm");
  const onAudit = config?.onAudit;

  const sessions = new Map<string, SessionState>();

  function getSession(sessionId: string): SessionState {
    const existing = sessions.get(sessionId);
    if (existing !== undefined) return existing;
    const sessionDir = join(baseTempDir, sessionId);
    mkdirSync(sessionDir, { recursive: true });
    const state: SessionState = {
      stores: new Map(),
      filePaths: new Map(),
      nextId: 0,
      sessionDir,
    };
    sessions.set(sessionId, state);
    return state;
  }

  /** Write content to temp file and create InputStore. */
  function virtualize(
    content: string,
    state: SessionState,
    sessionId: string,
    source: string,
  ): { readonly virtualId: string; readonly stub: string } {
    const virtualId = `v${String(state.nextId)}`;
    state.nextId++;

    const filePath = join(state.sessionDir, `${virtualId}.txt`);
    writeFileSync(filePath, content, "utf-8");

    const store = createInputStore(content, { chunkSize, previewLength });
    state.stores.set(virtualId, store);
    state.filePaths.set(virtualId, filePath);

    const meta = store.metadata();
    onAudit?.({
      kind: "virtualized",
      virtualId,
      source,
      format: meta.format,
      sizeBytes: meta.sizeBytes,
      estimatedTokens: meta.estimatedTokens,
      filePath,
      sessionId,
      timestamp: Date.now(),
    });

    return { virtualId, stub: generateStub(virtualId, filePath, meta) };
  }

  /** Rehydrate a store from a temp file referenced by a stub. */
  function rehydrate(
    virtualId: string,
    filePath: string,
    state: SessionState,
    sessionId: string,
  ): boolean {
    if (state.stores.has(virtualId)) return true;
    if (!existsSync(filePath)) return false;

    const content = readFileSync(filePath, "utf-8");
    const store = createInputStore(content, { chunkSize, previewLength });
    state.stores.set(virtualId, store);
    state.filePaths.set(virtualId, filePath);

    // Ensure nextId stays ahead of rehydrated IDs
    const idNum = parseInt(virtualId.slice(1), 10);
    if (idNum >= state.nextId) {
      state.nextId = idNum + 1;
    }

    onAudit?.({
      kind: "rehydrated",
      virtualId,
      filePath,
      sessionId,
      timestamp: Date.now(),
    });

    return true;
  }

  /** Scan messages for stubs and rehydrate from temp files. */
  function rehydrateFromHistory(
    messages: readonly InboundMessage[],
    state: SessionState,
    sessionId: string,
  ): void {
    for (const msg of messages) {
      for (const block of msg.content) {
        if (block.kind !== "text") continue;
        const parsed = parseStub(block.text);
        if (parsed !== undefined) {
          rehydrate(parsed.virtualId, parsed.filePath, state, sessionId);
        }
      }
    }
  }

  /** Scan messages and virtualize oversized text blocks. */
  function virtualizeMessages(
    messages: readonly InboundMessage[],
    state: SessionState,
    sessionId: string,
  ): { readonly messages: readonly InboundMessage[]; readonly didVirtualize: boolean } {
    // let: track whether any block was virtualized
    let didVirtualize = false;
    const result: InboundMessage[] = [];

    for (const msg of messages) {
      // Skip system messages
      if (msg.senderId.startsWith("system:") || msg.senderId === "system") {
        result.push(msg);
        continue;
      }

      const newBlocks = msg.content.map((block: ContentBlock) => {
        if (block.kind !== "text") return block;

        // Skip blocks that are already stubs
        if (block.text.startsWith(STUB_MARKER)) return block;

        const tokens = estimateTokens(block.text);
        if (tokens < threshold) return block;

        const { stub } = virtualize(block.text, state, sessionId, `message:${msg.senderId}`);
        didVirtualize = true;
        return { kind: "text" as const, text: stub };
      });

      result.push({ ...msg, content: newBlocks });
    }

    return { messages: result, didVirtualize };
  }

  /** Inject RLM access tools into request if not already present. */
  function injectTools(request: ModelRequest): ModelRequest {
    const existingNames = new Set(request.tools?.map((t) => t.name) ?? []);
    const newTools = ALL_VIRTUALIZE_DESCRIPTORS.filter((d) => !existingNames.has(d.name));
    if (newTools.length === 0) return request;

    const tools = [...(request.tools ?? []), ...newTools];
    return { ...request, tools };
  }

  return {
    name: "rlm-virtualize",
    priority,

    describeCapabilities: (_ctx: TurnContext): CapabilityFragment => ({
      label: "rlm-virtualize",
      description:
        "Auto-virtualizes oversized content; injects rlm_examine, rlm_chunk, rlm_input_info tools",
    }),

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      const sessionId = ctx.sessionId as string;
      const state = sessions.get(sessionId);
      if (state !== undefined) {
        // Emit eviction events for audit trail
        for (const [virtualId, filePath] of state.filePaths) {
          onAudit?.({
            kind: "evicted",
            virtualId,
            filePath,
            sessionId,
            timestamp: Date.now(),
          });
        }
        // Note: temp files are NOT deleted — they persist for session resume.
        // Cleanup is the responsibility of the deployment (tmpdir rotation, etc.)
        sessions.delete(sessionId);
      }
    },

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: (request: ModelRequest) => Promise<ModelResponse>,
    ): Promise<ModelResponse> {
      const sessionId = ctx.session.sessionId as string;
      const state = getSession(sessionId);

      // Rehydrate stores from stubs in historical messages
      rehydrateFromHistory(request.messages, state, sessionId);

      // Virtualize oversized content in current messages
      const { messages } = virtualizeMessages(request.messages, state, sessionId);

      // Inject tools if any stores exist (current or rehydrated)
      const hasStores = state.stores.size > 0;
      const enrichedRequest = hasStores
        ? injectTools({ ...request, messages })
        : { ...request, messages };

      return next(enrichedRequest);
    },

    async wrapToolCall(
      ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      const sessionId = ctx.session.sessionId as string;
      const state = getSession(sessionId);
      const registry = createRegistry(state);

      // Dispatch RLM access tools locally
      if (VIRTUALIZE_TOOL_NAMES.has(request.toolId)) {
        if (request.toolId === RLM_EXAMINE_NAME) {
          const result = dispatchExamine(registry, request.input);
          return { output: result.output };
        }
        if (request.toolId === RLM_CHUNK_NAME) {
          const result = dispatchChunk(registry, request.input);
          return { output: result.output };
        }
        if (request.toolId === RLM_INPUT_INFO_NAME) {
          const result = dispatchInputInfo(registry, request.input);
          return { output: result.output };
        }
      }

      // Pass through to next handler for non-RLM tools
      const response = await next(request);

      // Check if tool output is oversized — virtualize if so
      if (response.output !== undefined && response.output !== null) {
        const outputStr =
          typeof response.output === "string" ? response.output : JSON.stringify(response.output);
        const tokens = estimateTokens(outputStr);

        if (tokens >= threshold) {
          const { stub } = virtualize(outputStr, state, sessionId, `tool_output:${request.toolId}`);
          return { ...response, output: stub };
        }
      }

      return response;
    },
  };
}
