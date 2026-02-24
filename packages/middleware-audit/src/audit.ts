/**
 * Audit middleware factory — compliance logging and PII redaction.
 */

import type {
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  SessionContext,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core/middleware";
import { swallowError } from "@koi/errors";
import type { AuditMiddlewareConfig } from "./config.js";
import type { AuditEntry } from "./sink.js";
import { applyRedaction, truncate } from "./sink.js";

const DEFAULT_MAX_ENTRY_SIZE = 10_000;

function safeSerialize(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

function processPayload(value: unknown, config: AuditMiddlewareConfig): unknown {
  const maxSize = config.maxEntrySize ?? DEFAULT_MAX_ENTRY_SIZE;
  let serialized = safeSerialize(value);

  if (config.redactionRules && config.redactionRules.length > 0) {
    serialized = applyRedaction(serialized, config.redactionRules);
  }

  serialized = truncate(serialized, maxSize);

  try {
    return JSON.parse(serialized);
  } catch {
    return serialized;
  }
}

export function createAuditMiddleware(config: AuditMiddlewareConfig): KoiMiddleware {
  const { sink, onError } = config;

  function fireAndForget(entry: AuditEntry): void {
    void sink.log(entry).catch((error: unknown) => {
      if (onError) {
        onError(error, entry);
      } else {
        swallowError(error, { package: "middleware-audit", operation: "sink.log" });
      }
    });
  }

  return {
    name: "audit",
    priority: 300,

    async onSessionStart(ctx: SessionContext): Promise<void> {
      const entry: AuditEntry = {
        timestamp: Date.now(),
        sessionId: ctx.sessionId,
        agentId: ctx.agentId,
        turnIndex: -1,
        kind: "session_start",
        durationMs: 0,
        metadata: ctx.metadata,
      };
      fireAndForget(entry);
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      const entry: AuditEntry = {
        timestamp: Date.now(),
        sessionId: ctx.sessionId,
        agentId: ctx.agentId,
        turnIndex: -1,
        kind: "session_end",
        durationMs: 0,
        metadata: ctx.metadata,
      };
      fireAndForget(entry);

      if (sink.flush) {
        await sink.flush();
      }
    },

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      const startTime = Date.now();
      let response: ModelResponse | undefined;
      let error: unknown;

      try {
        response = await next(request);
        return response;
      } catch (e: unknown) {
        error = e;
        throw e;
      } finally {
        const durationMs = Date.now() - startTime;
        const entry: AuditEntry = {
          timestamp: startTime,
          sessionId: ctx.session.sessionId,
          agentId: ctx.session.agentId,
          turnIndex: ctx.turnIndex,
          kind: "model_call",
          request: config.redactRequestBodies ? "[redacted]" : processPayload(request, config),
          response: response ? processPayload(response, config) : undefined,
          error: error ? processPayload(error, config) : undefined,
          durationMs,
        };
        fireAndForget(entry);
      }
    },

    async wrapToolCall(
      ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      const startTime = Date.now();
      let response: ToolResponse | undefined;
      let error: unknown;

      try {
        response = await next(request);
        return response;
      } catch (e: unknown) {
        error = e;
        throw e;
      } finally {
        const durationMs = Date.now() - startTime;
        const entry: AuditEntry = {
          timestamp: startTime,
          sessionId: ctx.session.sessionId,
          agentId: ctx.session.agentId,
          turnIndex: ctx.turnIndex,
          kind: "tool_call",
          request: config.redactRequestBodies ? "[redacted]" : processPayload(request, config),
          response: response ? processPayload(response, config) : undefined,
          error: error ? processPayload(error, config) : undefined,
          durationMs,
        };
        fireAndForget(entry);
      }
    },
  };
}
