/**
 * Factory function for the filesystem rollback middleware.
 */

import type {
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

  const middleware: KoiMiddleware = {
    name: "fs-rollback",
    priority: 350,

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

      // 2. Execute the tool
      const response = await next(request);

      // 3. Re-read to get post-state
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

      return response;
    },
  };

  return {
    middleware,

    rollbackTo: (targetNodeId: NodeId) => rollbackToImpl(store, chainId, targetNodeId, backend),

    getRecords: async () => {
      const result = await store.list(chainId);
      return result;
    },
  };
}
