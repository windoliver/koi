/**
 * Factory function for the filesystem rollback middleware.
 */

import type {
  CapabilityFragment,
  FileOpRecord,
  KoiMiddleware,
  NodeId,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { toolCallId } from "@koi/core";
import { capturePreState, DEFAULT_MAX_CAPTURE_SIZE } from "./capture.js";
import { rollbackTo as rollbackToImpl } from "./rollback.js";
import type { FsRollbackConfig, FsRollbackHandle } from "./types.js";

/** Default tool ID prefix for filesystem tools. */
const DEFAULT_TOOL_PREFIX = "fs";

/**
 * Returns true if the tool ID matches an fs_write or fs_edit operation.
 */
function isFsToolCall(toolId: string, prefix: string): boolean {
  return toolId === `${prefix}_write` || toolId === `${prefix}_edit`;
}

/**
 * Determines the FileOpKind from a tool ID.
 */
function toolIdToOpKind(toolId: string, prefix: string): "write" | "edit" {
  return toolId === `${prefix}_write` ? "write" : "edit";
}

/**
 * Creates a filesystem rollback middleware that captures pre/post state
 * of file operations during tool calls.
 */
export function createFsRollbackMiddleware(config: FsRollbackConfig): FsRollbackHandle {
  const {
    store,
    chainId,
    backend,
    toolPrefix = DEFAULT_TOOL_PREFIX,
    maxCaptureSize = DEFAULT_MAX_CAPTURE_SIZE,
    getEventIndex,
  } = config;

  // let justification: middleware instance tracks linear chain of snapshots + monotonic callId
  let lastNodeId: NodeId | undefined;
  let callCounter = 0;

  const capabilityFragment: CapabilityFragment = {
    label: "fs-rollback",
    description: "Filesystem rollback on error enabled",
  };

  const middleware: KoiMiddleware = {
    name: "fs-rollback",
    priority: 350,

    describeCapabilities: (_ctx: TurnContext) => capabilityFragment,

    wrapToolCall: async (
      ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> => {
      // Passthrough for non-filesystem tools
      if (!isFsToolCall(request.toolId, toolPrefix)) {
        return next(request);
      }

      // Extract path from tool input
      const filePath = request.input.path;
      if (typeof filePath !== "string") {
        // No path in input — passthrough
        return next(request);
      }

      // 1. Capture pre-state
      const previousContent = await capturePreState(backend, filePath, maxCaptureSize);

      // 2. Execute the tool — may throw after mutating the file
      // let: toolError is set in catch, checked after record to decide re-throw
      let toolError: unknown;
      // let: response is assigned on success path
      let response: ToolResponse | undefined;
      try {
        response = await next(request);
      } catch (e: unknown) {
        toolError = e;
      }

      // 3. Re-read to get post-state (file may have been mutated even on failure)
      const postResult = await backend.read(filePath);
      const newContent = postResult.ok ? postResult.value.content : "";

      // 4. Build FileOpRecord
      const record: FileOpRecord = {
        callId: toolCallId(`${request.toolId}-${Date.now()}-${callCounter++}`),
        kind: toolIdToOpKind(request.toolId, toolPrefix),
        path: filePath,
        previousContent,
        newContent,
        turnIndex: ctx.turnIndex,
        eventIndex: getEventIndex !== undefined ? getEventIndex() : -1,
        timestamp: Date.now(),
      };

      // 5. Store the record
      const parentIds = lastNodeId !== undefined ? [lastNodeId] : [];
      const putResult = await store.put(chainId, record, parentIds);
      if (putResult.ok && putResult.value !== undefined) {
        lastNodeId = putResult.value.nodeId;
      }

      // 6. Re-throw if tool failed
      if (toolError !== undefined) throw toolError;
      // response is guaranteed defined when toolError is undefined
      return response as ToolResponse;
    },
  };

  return {
    middleware,

    rollbackTo: async (targetNodeId: NodeId) => {
      const result = await rollbackToImpl(store, chainId, targetNodeId, backend);
      if (result.ok) {
        lastNodeId = targetNodeId;
      }
      return result;
    },

    getRecords: async () => {
      const result = await store.list(chainId);
      return result;
    },
  };
}
