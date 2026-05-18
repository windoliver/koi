import type {
  EngineEvent,
  EngineInput,
  InboundMessage,
  JsonObject,
  ResolvedWorkspaceConfig,
  WorkspaceBackend,
  WorkspaceId,
  WorkspaceInfo,
} from "@koi/core";
import { agentId } from "@koi/core";
import type {
  AuthResult,
  ConnectFrame,
  Gateway,
  GatewayAuthenticator,
  GatewayFrame,
  RoutingContext,
  Session,
} from "@koi/gateway";
import {
  authenticateRemoteRequest,
  type RemoteAuthenticatorOptions,
  type RemoteAuthRequest,
  type RemoteAuthResult,
} from "@koi/remote";
import { createGatewayStack } from "./create-gateway-stack.js";
import type { GatewayStack, GatewayStackConfig, GatewayStackDeps } from "./types.js";

const DEFAULT_WORKSPACE_CONFIG: ResolvedWorkspaceConfig = {
  cleanupPolicy: "always",
  cleanupTimeoutMs: 30_000,
};

export interface RemoteGatewayAuthenticatorConfig {
  readonly url: string | ((frame: ConnectFrame) => string);
  readonly remote?: RemoteAuthenticatorOptions | undefined;
  readonly authenticateRemote?:
    | ((request: RemoteAuthRequest) => RemoteAuthResult | Promise<RemoteAuthResult>)
    | undefined;
  readonly resolveSessionId?:
    | ((auth: Extract<RemoteAuthResult, { readonly ok: true }>, frame: ConnectFrame) => string)
    | undefined;
  readonly resolveAgentId?:
    | ((auth: Extract<RemoteAuthResult, { readonly ok: true }>, frame: ConnectFrame) => string)
    | undefined;
  readonly resolveRouting?:
    | ((
        auth: Extract<RemoteAuthResult, { readonly ok: true }>,
        frame: ConnectFrame,
      ) => RoutingContext)
    | undefined;
}

export interface RemoteSessionRuntime {
  readonly runFrame: (session: Session, frame: GatewayFrame) => void | Promise<void>;
  readonly dispose: () => void | Promise<void>;
}

export interface RemoteEngineRuntime {
  readonly run: (input: EngineInput) => AsyncIterable<EngineEvent>;
  readonly dispose?: (() => void | Promise<void>) | undefined;
}

export interface GatewayRemoteSessionRuntimeConfig {
  readonly gateway: Pick<Gateway, "send">;
  readonly runtime: RemoteEngineRuntime;
  readonly nextFrameId?: (() => string) | undefined;
  readonly nowMs?: (() => number) | undefined;
  readonly onRuntimeError?:
    | ((
        error: unknown,
        context: { readonly session: Session; readonly frame: GatewayFrame },
      ) => void)
    | undefined;
}

export interface RemoteRuntimeCreateInput {
  readonly session: Session;
  readonly workspace: WorkspaceInfo;
  readonly gateway: Gateway;
}

export interface RemoteSessionBridgeConfig {
  readonly gateway: Gateway;
  readonly workspace: WorkspaceBackend;
  readonly workspaceConfig?: ResolvedWorkspaceConfig | undefined;
  readonly createRuntime: (input: RemoteRuntimeCreateInput) => Promise<RemoteSessionRuntime>;
  readonly onBridgeError?:
    | ((
        error: unknown,
        context: { readonly operation: string; readonly sessionId: string },
      ) => void)
    | undefined;
}

export interface RemoteSessionBridgeHandle {
  readonly dispose: () => Promise<void>;
}

export interface RemoteGatewayStackConfig extends GatewayStackConfig {
  readonly remote: RemoteGatewayAuthenticatorConfig;
  readonly workspaceConfig?: ResolvedWorkspaceConfig | undefined;
}

export interface RemoteGatewayStackDeps extends Omit<GatewayStackDeps, "auth"> {
  readonly workspace: WorkspaceBackend;
  readonly createRuntime: (input: RemoteRuntimeCreateInput) => Promise<RemoteSessionRuntime>;
}

export interface RemoteGatewayStack extends GatewayStack {
  readonly remoteBridge: RemoteSessionBridgeHandle;
}

export interface RemoteGatewayStackInternals {
  readonly createGatewayStack: typeof createGatewayStack;
  readonly createRemoteGatewayAuthenticator: typeof createRemoteGatewayAuthenticator;
  readonly attachRemoteSessionBridge: typeof attachRemoteSessionBridge;
}

interface RemoteSessionRecord {
  readonly sessionId: string;
  readonly workspace: WorkspaceInfo;
  readonly runtime: RemoteSessionRuntime;
}

interface ActiveGatewayRequest {
  readonly controller: AbortController;
  readonly completion: Promise<void>;
  cancellationSent: boolean;
}

const DEFAULT_REMOTE_GATEWAY_STACK_INTERNALS: RemoteGatewayStackInternals = {
  createGatewayStack,
  createRemoteGatewayAuthenticator,
  attachRemoteSessionBridge,
};

export function createRemoteGatewayStack(
  config: RemoteGatewayStackConfig,
  deps: RemoteGatewayStackDeps,
  internals: RemoteGatewayStackInternals = DEFAULT_REMOTE_GATEWAY_STACK_INTERNALS,
): RemoteGatewayStack {
  const { workspace, createRuntime, ...stackDeps } = deps;
  const auth = internals.createRemoteGatewayAuthenticator(config.remote);
  const stack = internals.createGatewayStack(toGatewayStackConfig(config), { ...stackDeps, auth });
  const remoteBridge = internals.attachRemoteSessionBridge({
    gateway: stack.gateway,
    workspace,
    createRuntime,
    ...(config.workspaceConfig !== undefined ? { workspaceConfig: config.workspaceConfig } : {}),
  });

  return {
    ...stack,
    remoteBridge,
    async stop(): Promise<void> {
      let bridgeError: unknown;
      try {
        await remoteBridge.dispose();
      } catch (err: unknown) {
        bridgeError = err;
      }
      try {
        await stack.stop();
      } catch (stackError: unknown) {
        if (bridgeError !== undefined) {
          throw new AggregateError(
            [bridgeError, stackError],
            "remote bridge and gateway stack stop failed",
          );
        }
        throw stackError;
      }
      if (bridgeError !== undefined) throw bridgeError;
    },
  };
}

export function createGatewayRemoteSessionRuntime(
  config: GatewayRemoteSessionRuntimeConfig,
): RemoteSessionRuntime {
  const activeRequests = new Map<string, ActiveGatewayRequest>();
  const nextFrameId = config.nextFrameId ?? (() => crypto.randomUUID());
  const nowMs = config.nowMs ?? (() => Date.now());

  return {
    runFrame(session, frame): void {
      const cancelRequestId = getCancelRequestId(frame.payload);
      if (cancelRequestId !== undefined) {
        const request = activeRequests.get(cancelRequestId);
        if (request === undefined) return;
        if (request.cancellationSent) return;
        request.cancellationSent = true;
        request.controller.abort("user_cancel");
        try {
          sendGatewayFrame(config.gateway, session, {
            kind: "error",
            id: nextFrameId(),
            ref: cancelRequestId,
            seq: 0,
            timestamp: nowMs(),
            payload: { code: "CANCELLED", message: "Request cancelled" },
          });
        } catch (err: unknown) {
          config.onRuntimeError?.(err, { session, frame });
        }
        return;
      }

      if (activeRequests.has(frame.id)) return;
      const controller = new AbortController();
      const completion = runAndReply(
        config,
        nextFrameId,
        nowMs,
        session,
        frame,
        controller,
      ).finally(() => {
        activeRequests.delete(frame.id);
      });
      activeRequests.set(frame.id, { controller, completion, cancellationSent: false });
    },
    async dispose(): Promise<void> {
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
    },
  };
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
}

export function createRemoteGatewayAuthenticator(
  config: RemoteGatewayAuthenticatorConfig,
): GatewayAuthenticator {
  return {
    authenticate: async (frame): Promise<AuthResult> => {
      const remote = await runRemoteAuth(config, frame);
      if (!remote.ok) return mapRemoteReject(remote.reason);

      return {
        ok: true,
        sessionId: resolveRemoteSessionId(config, remote, frame),
        agentId: resolveRemoteAgentId(config, remote, frame),
        metadata: {
          remoteSubject: remote.subject,
          remoteDeviceId: remote.deviceId,
          remotePermissions: remote.permissions,
          remoteMetadata: remote.metadata,
        },
        routing: resolveRemoteRouting(config, remote, frame),
      };
    },
  };
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
  const content = payload.content;
  if (Array.isArray(content)) {
    const text = content
      .map((block) => {
        if (!isRecord(block)) return "";
        const value = block.text;
        return typeof value === "string" ? value : "";
      })
      .join("\n");
    if (content.length > 0) return text;
  }
  return stringifyPromptPayload(payload);
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

function toGatewayStackConfig(config: RemoteGatewayStackConfig): GatewayStackConfig {
  return {
    ...(config.gateway !== undefined ? { gateway: config.gateway } : {}),
    ...(config.canvas !== undefined ? { canvas: config.canvas } : {}),
    ...(config.webhook !== undefined ? { webhook: config.webhook } : {}),
    ...(config.nexus !== undefined ? { nexus: config.nexus } : {}),
  };
}

export function attachRemoteSessionBridge(
  config: RemoteSessionBridgeConfig,
): RemoteSessionBridgeHandle {
  const records = new Map<string, Promise<RemoteSessionRecord>>();
  const agentUnsubscribers = new Map<string, () => void>();
  const sessionAgents = new Map<string, string>();
  const workspaceConfig = config.workspaceConfig ?? DEFAULT_WORKSPACE_CONFIG;

  function registerAgent(agent: string): void {
    if (agentUnsubscribers.has(agent)) return;
    const unsubscribe = config.gateway.onFrame(agent, async (session, frame) => {
      if (frame.kind !== "request") return;
      if (isTerminateFrame(frame)) {
        await terminateSession(config, records, session.id);
        return;
      }
      const record = await ensureRecord(config, records, workspaceConfig, session);
      await record.runtime.runFrame(session, frame);
    });
    agentUnsubscribers.set(agent, unsubscribe);
  }

  function unregisterAgentIfUnused(agent: string): void {
    for (const registeredAgent of sessionAgents.values()) {
      if (registeredAgent === agent) return;
    }
    agentUnsubscribers.get(agent)?.();
    agentUnsubscribers.delete(agent);
  }

  const unsubscribeSessions = config.gateway.onSessionEvent((event) => {
    if (event.kind === "created") {
      sessionAgents.set(event.session.id, event.session.agentId);
      registerAgent(event.session.agentId);
      return;
    }
    if (event.kind === "destroyed") {
      const agent = sessionAgents.get(event.sessionId);
      sessionAgents.delete(event.sessionId);
      if (agent !== undefined) unregisterAgentIfUnused(agent);
      void disposeRecord(config, records, event.sessionId).catch((err: unknown) => {
        config.onBridgeError?.(err, {
          operation: "dispose.destroyed-session",
          sessionId: event.sessionId,
        });
      });
    }
  });

  return {
    async dispose(): Promise<void> {
      unsubscribeSessions();
      for (const unsubscribe of agentUnsubscribers.values()) unsubscribe();
      agentUnsubscribers.clear();
      sessionAgents.clear();
      const settled = await Promise.allSettled(
        [...records.keys()].map((sessionId) => disposeRecord(config, records, sessionId)),
      );
      const failures = settled
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, "remote bridge session disposal failed");
      }
    },
  };
}

async function runRemoteAuth(
  config: RemoteGatewayAuthenticatorConfig,
  frame: ConnectFrame,
): Promise<RemoteAuthResult> {
  const request: RemoteAuthRequest = {
    bearerToken: frame.auth.token,
    transport: "websocket",
    operation: "stream",
    url: typeof config.url === "string" ? config.url : config.url(frame),
  };
  if (config.authenticateRemote !== undefined) return config.authenticateRemote(request);
  if (config.remote === undefined) {
    return { ok: false, reason: "jwt_rejected" };
  }
  return authenticateRemoteRequest(request, config.remote);
}

function mapRemoteReject(
  reason: Exclude<RemoteAuthResult, { readonly ok: true }>["reason"],
): AuthResult {
  if (reason === "jwt_rejected") {
    return { ok: false, code: "INVALID_TOKEN", message: "Remote JWT rejected" };
  }
  if (reason === "untrusted_device") {
    return { ok: false, code: "FORBIDDEN", message: "Remote device is not trusted" };
  }
  if (reason === "permission_rejected") {
    return { ok: false, code: "FORBIDDEN", message: "Remote permissions rejected" };
  }
  return { ok: false, code: "FORBIDDEN", message: "Remote transport rejected" };
}

function resolveRemoteSessionId(
  config: RemoteGatewayAuthenticatorConfig,
  remote: Extract<RemoteAuthResult, { readonly ok: true }>,
  frame: ConnectFrame,
): string {
  return config.resolveSessionId?.(remote, frame) ?? `remote:${remote.subject}:${remote.deviceId}`;
}

function resolveRemoteAgentId(
  config: RemoteGatewayAuthenticatorConfig,
  remote: Extract<RemoteAuthResult, { readonly ok: true }>,
  frame: ConnectFrame,
): string {
  return (
    config.resolveAgentId?.(remote, frame) ?? remote.agentId ?? frame.client?.id ?? remote.subject
  );
}

function resolveRemoteRouting(
  config: RemoteGatewayAuthenticatorConfig,
  remote: Extract<RemoteAuthResult, { readonly ok: true }>,
  frame: ConnectFrame,
): RoutingContext {
  return config.resolveRouting?.(remote, frame) ?? { peer: frame.client?.id ?? remote.deviceId };
}

async function ensureRecord(
  config: RemoteSessionBridgeConfig,
  records: Map<string, Promise<RemoteSessionRecord>>,
  workspaceConfig: ResolvedWorkspaceConfig,
  session: Session,
): Promise<RemoteSessionRecord> {
  const existing = records.get(session.id);
  if (existing !== undefined) return existing;

  const created = createRecord(config, workspaceConfig, session).catch(async (err: unknown) => {
    records.delete(session.id);
    try {
      await destroyGatewaySession(config.gateway, session.id, "remote bridge spawn failed");
    } catch (destroyError: unknown) {
      throw new AggregateError(
        [err, destroyError],
        `remote runtime spawn failed and session ${session.id} destroy failed`,
      );
    }
    throw err;
  });
  records.set(session.id, created);
  return created;
}

async function createRecord(
  config: RemoteSessionBridgeConfig,
  workspaceConfig: ResolvedWorkspaceConfig,
  session: Session,
): Promise<RemoteSessionRecord> {
  const workspaceResult = await config.workspace.create(agentId(session.agentId), workspaceConfig);
  if (!workspaceResult.ok) {
    throw new Error(workspaceResult.error.message, { cause: workspaceResult.error });
  }
  try {
    const runtime = await config.createRuntime({
      session,
      workspace: workspaceResult.value,
      gateway: config.gateway,
    });
    return { sessionId: session.id, workspace: workspaceResult.value, runtime };
  } catch (err: unknown) {
    try {
      await disposeWorkspace(config.workspace, workspaceResult.value.id);
    } catch (disposeError: unknown) {
      throw new AggregateError(
        [err, disposeError],
        `remote runtime spawn failed and workspace ${workspaceResult.value.id} cleanup failed`,
      );
    }
    throw err;
  }
}

async function terminateSession(
  config: RemoteSessionBridgeConfig,
  records: Map<string, Promise<RemoteSessionRecord>>,
  sessionId: string,
): Promise<void> {
  let disposeError: unknown;
  try {
    await disposeRecord(config, records, sessionId);
  } catch (err: unknown) {
    disposeError = err;
  }
  try {
    await destroyGatewaySession(config.gateway, sessionId, "remote terminate");
  } catch (destroyError: unknown) {
    if (disposeError !== undefined) {
      throw new AggregateError(
        [disposeError, destroyError],
        `remote session ${sessionId} disposal and destroy failed`,
      );
    }
    throw destroyError;
  }
  if (disposeError !== undefined) throw disposeError;
}

async function destroyGatewaySession(
  gateway: Pick<Gateway, "destroySession">,
  sessionId: string,
  reason: string,
): Promise<void> {
  const result = await gateway.destroySession(sessionId, reason);
  if (!result.ok) {
    throw new Error(result.error.message, { cause: result.error });
  }
}

async function disposeRecord(
  config: RemoteSessionBridgeConfig,
  records: Map<string, Promise<RemoteSessionRecord>>,
  sessionId: string,
): Promise<void> {
  const pending = records.get(sessionId);
  if (pending === undefined) return;
  records.delete(sessionId);
  const record = await pending;
  let disposeError: unknown;
  try {
    await record.runtime.dispose();
  } catch (err: unknown) {
    disposeError = err;
  }
  try {
    await disposeWorkspace(config.workspace, record.workspace.id);
  } catch (workspaceError: unknown) {
    if (disposeError !== undefined) {
      throw new AggregateError(
        [disposeError, workspaceError],
        `remote runtime and workspace ${record.workspace.id} disposal failed`,
      );
    }
    throw workspaceError;
  }
  if (disposeError !== undefined) throw disposeError;
}

async function disposeWorkspace(
  workspace: WorkspaceBackend,
  workspaceId: WorkspaceId,
): Promise<void> {
  const result = await workspace.dispose(workspaceId);
  if (!result.ok) {
    throw new Error(result.error.message, { cause: result.error });
  }
}

function isTerminateFrame(frame: GatewayFrame): boolean {
  if (!isRecord(frame.payload)) return false;
  return frame.payload.operation === "terminate" || frame.payload.kind === "terminate";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}
