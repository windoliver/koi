/**
 * Audit middleware factory — security-grade compliance logging.
 *
 * Intercepts all 6 auditable event categories:
 *   model_call, tool_call, session_start, session_end,
 *   permission_decision, config_change
 *
 * Features: bounded backpressure queue, hash chain, Ed25519 signing,
 * structured redaction via @koi/redaction (single serialize pass).
 */

import type { AuditEntry } from "@koi/core";
import type {
  CapabilityFragment,
  ConfigChange,
  KoiMiddleware,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  SessionContext,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core/middleware";
import type { PermissionDecision, PermissionQuery } from "@koi/core/permission-backend";
import { createRedactor } from "@koi/redaction";
import type { AuditMiddlewareConfig } from "./config.js";
import { createBoundedQueue } from "./queue.js";
import type { SigningHandle } from "./signing.js";
import { createEphemeralSigningHandle } from "./signing.js";

const SCHEMA_VERSION = 1;
const DEFAULT_MAX_ENTRY_SIZE = 10_000;
const DEFAULT_MAX_QUEUE_DEPTH = 1000;

/** KoiMiddleware extended with audit-specific surface. */
export interface AuditMiddleware extends KoiMiddleware {
  /** Drain all pending entries and flush the underlying sink. Use in tests + shutdown. */
  readonly flush: () => Promise<void>;
  /** DER-encoded SPKI public key for signature verification. Undefined when signing disabled. */
  readonly signingPublicKey: Buffer | undefined;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...[truncated]`;
}

export function createAuditMiddleware(config: AuditMiddlewareConfig): AuditMiddleware {
  const maxEntrySize = config.maxEntrySize ?? DEFAULT_MAX_ENTRY_SIZE;
  const maxQueueDepth = config.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH;

  const redactor = createRedactor(config.redaction);

  const queue = createBoundedQueue({
    sink: config.sink,
    maxQueueDepth,
    ...(config.onOverflow !== undefined ? { onOverflow: config.onOverflow } : {}),
    ...(config.onError !== undefined ? { onError: config.onError } : {}),
  });

  // Resolve signing handle
  const signingHandle: SigningHandle | undefined =
    config.signing === true ? createEphemeralSigningHandle() : undefined;

  function redactPayload(value: unknown): unknown {
    if (value === undefined) return undefined;
    const result = redactor.redactObject(value);
    const serialized = JSON.stringify(result.value);
    if (serialized.length > maxEntrySize) {
      return truncate(serialized, maxEntrySize);
    }
    return result.value;
  }

  function buildAndEnqueue(base: Omit<AuditEntry, "schema_version">): void {
    const entry: AuditEntry = { schema_version: SCHEMA_VERSION, ...base };
    const stamped = signingHandle ? signingHandle.stamp(entry) : entry;
    queue.enqueue(stamped);
  }

  const capabilityFragment: CapabilityFragment = {
    label: "audit",
    description: "Compliance audit logging active",
  };

  return {
    name: "audit",
    priority: 300,
    phase: "observe",

    describeCapabilities: (_ctx: TurnContext): CapabilityFragment => capabilityFragment,

    async onSessionStart(ctx: SessionContext): Promise<void> {
      buildAndEnqueue({
        timestamp: Date.now(),
        sessionId: ctx.sessionId,
        agentId: ctx.agentId,
        turnIndex: -1,
        kind: "session_start",
        durationMs: 0,
        metadata: ctx.metadata,
      });
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      // Build and enqueue synchronously (preserves chain order), then await flush
      buildAndEnqueue({
        timestamp: Date.now(),
        sessionId: ctx.sessionId,
        agentId: ctx.agentId,
        turnIndex: -1,
        kind: "session_end",
        durationMs: 0,
        metadata: ctx.metadata,
      });
      await queue.flush();
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
        buildAndEnqueue({
          timestamp: startTime,
          sessionId: ctx.session.sessionId,
          agentId: ctx.session.agentId,
          turnIndex: ctx.turnIndex,
          kind: "model_call",
          request: config.redactRequestBodies ? "[redacted]" : redactPayload(request),
          response: response !== undefined ? redactPayload(response) : undefined,
          error: error !== undefined ? redactPayload(error) : undefined,
          durationMs: Date.now() - startTime,
        });
      }
    },

    async *wrapModelStream(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      const startTime = Date.now();
      let lastResponse: ModelResponse | undefined;
      let error: unknown;

      try {
        for await (const chunk of next(request)) {
          if (chunk.kind === "done") {
            lastResponse = chunk.response;
          }
          yield chunk;
        }
      } catch (e: unknown) {
        error = e;
        throw e;
      } finally {
        buildAndEnqueue({
          timestamp: startTime,
          sessionId: ctx.session.sessionId,
          agentId: ctx.session.agentId,
          turnIndex: ctx.turnIndex,
          kind: "model_call",
          request: config.redactRequestBodies ? "[redacted]" : redactPayload(request),
          response: lastResponse !== undefined ? redactPayload(lastResponse) : undefined,
          error: error !== undefined ? redactPayload(error) : undefined,
          durationMs: Date.now() - startTime,
        });
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
        buildAndEnqueue({
          timestamp: startTime,
          sessionId: ctx.session.sessionId,
          agentId: ctx.session.agentId,
          turnIndex: ctx.turnIndex,
          kind: "tool_call",
          request: config.redactRequestBodies ? "[redacted]" : redactPayload(request),
          response: response !== undefined ? redactPayload(response) : undefined,
          error: error !== undefined ? redactPayload(error) : undefined,
          durationMs: Date.now() - startTime,
        });
      }
    },

    onPermissionDecision(
      ctx: TurnContext,
      query: PermissionQuery,
      decision: PermissionDecision,
    ): void {
      buildAndEnqueue({
        timestamp: Date.now(),
        sessionId: ctx.session.sessionId,
        agentId: ctx.session.agentId,
        turnIndex: ctx.turnIndex,
        kind: "permission_decision",
        request: redactPayload(query),
        response: redactPayload(decision),
        durationMs: 0,
      });
    },

    onConfigChange(ctx: SessionContext, change: ConfigChange): void {
      buildAndEnqueue({
        timestamp: Date.now(),
        sessionId: ctx.sessionId,
        agentId: ctx.agentId,
        turnIndex: -1,
        kind: "config_change",
        request: redactPayload({ key: change.key, oldValue: change.oldValue }),
        response: redactPayload({ newValue: change.newValue }),
        durationMs: 0,
      });
    },

    flush: queue.flush,
    signingPublicKey: signingHandle?.publicKeyDer,
  };
}
