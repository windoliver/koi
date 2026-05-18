import type { EngineEvent, InboundMessage, JsonObject } from "@koi/core";
import type { Gateway, GatewayFrame, Session } from "@koi/gateway";
import type {
  GatewayRemoteSessionRuntimeConfig,
  RemoteEngineRuntime,
  RemoteSessionRuntime,
} from "./remote-bridge-types.js";
import { isRecord } from "./remote-bridge-util.js";

interface ActiveGatewayRequest {
  readonly controller: AbortController;
  readonly completion: Promise<void>;
  cancellationSent: boolean;
}

export function createGatewayRemoteSessionRuntime(
  config: GatewayRemoteSessionRuntimeConfig,
): RemoteSessionRuntime {
  const activeRequests = new Map<string, ActiveGatewayRequest>();
  const nextFrameId = config.nextFrameId ?? (() => crypto.randomUUID());
  const nowMs = config.nowMs ?? (() => Date.now());

  return {
    runFrame(session, frame): void {
      handleRuntimeFrame({ config, activeRequests, nextFrameId, nowMs, session, frame });
    },
    dispose: () => disposeRuntime(config, activeRequests),
  };
}

interface RuntimeFrameContext {
  readonly config: GatewayRemoteSessionRuntimeConfig;
  readonly activeRequests: Map<string, ActiveGatewayRequest>;
  readonly nextFrameId: () => string;
  readonly nowMs: () => number;
  readonly session: Session;
  readonly frame: GatewayFrame;
}

function handleRuntimeFrame(context: RuntimeFrameContext): void {
  const { activeRequests, frame } = context;
  const cancelRequestId = getCancelRequestId(frame.payload);
  if (cancelRequestId !== undefined) {
    cancelRuntimeRequest(context, cancelRequestId);
    return;
  }
  if (activeRequests.has(frame.id)) return;
  startRuntimeRequest(context);
}

function cancelRuntimeRequest(context: RuntimeFrameContext, requestId: string): void {
  const { activeRequests, config, frame, nextFrameId, nowMs, session } = context;
  const request = activeRequests.get(requestId);
  if (request === undefined) return;
  if (request.cancellationSent) return;
  request.cancellationSent = true;
  request.controller.abort("user_cancel");
  try {
    sendGatewayFrame(config.gateway, session, {
      kind: "error",
      id: nextFrameId(),
      ref: requestId,
      seq: 0,
      timestamp: nowMs(),
      payload: { code: "CANCELLED", message: "Request cancelled" },
    });
  } catch (err: unknown) {
    config.onRuntimeError?.(err, { session, frame });
  }
}

function startRuntimeRequest(context: RuntimeFrameContext): void {
  const { activeRequests, config, frame, nextFrameId, nowMs, session } = context;
  const controller = new AbortController();
  const completion = runAndReply(config, nextFrameId, nowMs, session, frame, controller).finally(
    () => {
      activeRequests.delete(frame.id);
    },
  );
  activeRequests.set(frame.id, { controller, completion, cancellationSent: false });
}

async function disposeRuntime(
  config: GatewayRemoteSessionRuntimeConfig,
  activeRequests: Map<string, ActiveGatewayRequest>,
): Promise<void> {
  const pending = [...activeRequests.values()];
  for (const request of pending) request.controller.abort("shutdown");
  activeRequests.clear();
  let disposeError: unknown;
  try {
    await config.runtime.dispose?.();
  } catch (err: unknown) {
    disposeError = err;
  }
  await Promise.allSettled(pending.map((request) => request.completion));
  if (disposeError !== undefined) throw disposeError;
}

async function runAndReply(
  config: GatewayRemoteSessionRuntimeConfig,
  nextFrameId: () => string,
  nowMs: () => number,
  session: Session,
  frame: GatewayFrame,
  controller: AbortController,
): Promise<void> {
  try {
    const output = await runEngineFrame(config.runtime, session, frame, controller.signal);
    if (controller.signal.aborted) return;
    sendGatewayFrame(config.gateway, session, {
      kind: "response",
      id: nextFrameId(),
      ref: frame.id,
      seq: 0,
      timestamp: nowMs(),
      payload: output,
    });
  } catch (err: unknown) {
    if (controller.signal.aborted) return;
    reportRuntimeError(config, nextFrameId, nowMs, session, frame, err);
  }
}

function reportRuntimeError(
  config: GatewayRemoteSessionRuntimeConfig,
  nextFrameId: () => string,
  nowMs: () => number,
  session: Session,
  frame: GatewayFrame,
  err: unknown,
): void {
  try {
    sendGatewayFrame(config.gateway, session, {
      kind: "error",
      id: nextFrameId(),
      ref: frame.id,
      seq: 0,
      timestamp: nowMs(),
      payload: { code: "RUNTIME_ERROR", message: errorMessage(err) },
    });
  } catch (sendError: unknown) {
    config.onRuntimeError?.(sendError, { session, frame });
    return;
  }
  config.onRuntimeError?.(err, { session, frame });
}

async function runEngineFrame(
  runtime: RemoteEngineRuntime,
  session: Session,
  frame: GatewayFrame,
  signal: AbortSignal,
): Promise<JsonObject> {
  let text = "";
  let terminal: Extract<EngineEvent, { readonly kind: "done" }> | undefined;
  for await (const event of runtime.run({
    kind: "messages",
    messages: [inboundMessageFromFrame(session, frame)],
    signal,
  })) {
    if (event.kind === "text_delta") {
      text += event.delta;
    } else if (event.kind === "done") {
      terminal = event;
      break;
    }
  }
  if (signal.aborted) return {};
  if (terminal === undefined) {
    throw new Error(`remote runtime frame ${frame.id} ended without a done event`);
  }
  return outputFromDoneEvent(terminal, text);
}

function outputFromDoneEvent(
  terminal: Extract<EngineEvent, { readonly kind: "done" }>,
  text: string,
): JsonObject {
  const fallback = textFromContent(terminal.output.content);
  if (terminal.output.stopReason === "error") {
    throw new Error(fallback.length > 0 ? fallback : text || "remote runtime failed");
  }
  return {
    text: text.length > 0 ? text : fallback,
    stopReason: terminal.output.stopReason,
    metrics: terminal.output.metrics,
  };
}

function inboundMessageFromFrame(session: Session, frame: GatewayFrame): InboundMessage {
  return {
    senderId: session.agentId,
    threadId: session.id,
    timestamp: frame.timestamp,
    content: [{ kind: "text", text: extractPrompt(frame.payload) }],
    metadata: {
      source: "remote-gateway",
      frameId: frame.id,
      frameKind: frame.kind,
      ...(session.routing !== undefined ? { routing: session.routing } : {}),
      sessionMetadata: session.metadata,
    } satisfies JsonObject,
  };
}

function sendGatewayFrame(
  gateway: Pick<Gateway, "send">,
  session: Session,
  frame: GatewayFrame,
): void {
  const sent = gateway.send(session.agentId, session.id, frame);
  if (!sent.ok) {
    throw new Error(sent.error.message, { cause: sent.error });
  }
}

function getCancelRequestId(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  if (payload.kind !== "cancel") return undefined;
  return typeof payload.requestId === "string" && payload.requestId.length > 0
    ? payload.requestId
    : undefined;
}

function extractPrompt(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (!isRecord(payload)) return stringifyPromptPayload(payload);
  for (const key of ["text", "message", "prompt", "content"]) {
    const value = payload[key];
    if (typeof value === "string") return value;
  }
  const text = textFromPayloadContent(payload.content);
  return text ?? stringifyPromptPayload(payload);
}

function textFromPayloadContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((block) => {
      if (!isRecord(block)) return "";
      const value = block.text;
      return typeof value === "string" ? value : "";
    })
    .join("\n");
  return content.length > 0 ? text : undefined;
}

function stringifyPromptPayload(payload: unknown): string {
  try {
    return JSON.stringify(payload) ?? "";
  } catch {
    return String(payload);
  }
}

function textFromContent(
  content: Extract<EngineEvent, { readonly kind: "done" }>["output"]["content"],
): string {
  return content
    .filter((block) => block.kind === "text")
    .map((block) => block.text)
    .join("");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
