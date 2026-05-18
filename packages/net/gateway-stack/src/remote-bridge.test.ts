import { describe, expect, test } from "bun:test";
import type {
  AgentId,
  EngineEvent,
  EngineInput,
  KoiError,
  ResolvedWorkspaceConfig,
  Result,
  WorkspaceBackend,
  WorkspaceId,
  WorkspaceInfo,
} from "@koi/core";
import { agentId, RETRYABLE_DEFAULTS, workspaceId } from "@koi/core";
import type { Gateway, GatewayFrame, Session, SessionEvent, Transport } from "@koi/gateway";
import { createInMemoryNodeRegistry } from "@koi/gateway";
import {
  attachRemoteSessionBridge,
  createGatewayRemoteSessionRuntime,
  createRemoteGatewayAuthenticator,
  createRemoteGatewayStack,
  type RemoteGatewayStackInternals,
  type RemoteSessionBridgeConfig,
} from "./remote-bridge.js";
import type { GatewayStack, GatewayStackDeps } from "./types.js";

interface HarnessGateway extends Gateway {
  readonly emitSession: (event: SessionEvent) => void;
  readonly emitFrame: (session: Session, frame: GatewayFrame) => Promise<void>;
  readonly failDestroySession: (message: string | undefined) => void;
  readonly registeredAgents: () => readonly string[];
  readonly destroyed: readonly string[];
  readonly sent: readonly {
    readonly agentId: string;
    readonly sessionId: string;
    readonly frame: GatewayFrame;
  }[];
}

function makeGateway(): HarnessGateway {
  const nodeRegistry = createInMemoryNodeRegistry();
  const frameHandlers = new Map<
    string,
    (session: Session, frame: GatewayFrame) => void | Promise<void>
  >();
  const sessionHandlers = new Set<(event: SessionEvent) => void>();
  const destroyed: string[] = [];
  let destroyFailure: string | undefined;
  const sent: Array<{
    readonly agentId: string;
    readonly sessionId: string;
    readonly frame: GatewayFrame;
  }> = [];
  return {
    start: async () => {},
    stop: async () => ({ ok: true, value: undefined }),
    sessions: () => {
      throw new Error("not needed");
    },
    nodeRegistry: () => nodeRegistry,
    discoverNodeCapabilities: () => [],
    queryNodeCapabilities: () => ({ ok: true, value: 0 }),
    onNodeEvent: () => () => {},
    onFrame: (agent, handler) => {
      frameHandlers.set(agent, handler);
      return () => frameHandlers.delete(agent);
    },
    send: (agent, sessionId, frame) => {
      sent.push({ agentId: agent, sessionId, frame });
      return { ok: true, value: 1 };
    },
    dispatch: () => {},
    destroySession: async (sessionId) => {
      if (destroyFailure !== undefined) {
        return {
          ok: false,
          error: {
            code: "EXTERNAL",
            message: destroyFailure,
            retryable: RETRYABLE_DEFAULTS.EXTERNAL,
          },
        };
      }
      destroyed.push(sessionId);
      for (const handler of sessionHandlers) {
        handler({ kind: "destroyed", sessionId, reason: "test" });
      }
      return { ok: true, value: undefined };
    },
    onSessionEvent: (handler) => {
      sessionHandlers.add(handler);
      return () => sessionHandlers.delete(handler);
    },
    ingest: () => {},
    pauseIngress: () => {},
    forceClose: () => {},
    activeConnections: () => 0,
    emitSession: (event) => {
      for (const handler of sessionHandlers) handler(event);
    },
    emitFrame: async (session, frame) => {
      const handler = frameHandlers.get(session.agentId);
      if (handler === undefined) throw new Error(`no handler for ${session.agentId}`);
      await handler(session, frame);
    },
    failDestroySession: (message) => {
      destroyFailure = message;
    },
    registeredAgents: () => [...frameHandlers.keys()],
    destroyed,
    sent,
  };
}

function makeSession(id: string, agent = "agent-1"): Session {
  return {
    id,
    agentId: agent,
    connectedAt: 1_000,
    lastHeartbeat: 1_000,
    seq: 0,
    remoteSeq: 0,
    metadata: {},
  };
}

function makeFrame(seq: number, payload: unknown = `message ${seq}`): GatewayFrame {
  return { kind: "request", id: `frame-${seq}`, seq, payload, timestamp: 2_000 + seq };
}

function makeTransport(): Transport {
  let listening = false;
  return {
    listen: async () => {
      listening = true;
    },
    close: () => {
      listening = false;
    },
    connections: () => (listening ? 1 : 0),
  };
}

function makeWorkspaceBackend(): WorkspaceBackend & {
  readonly created: readonly {
    readonly agentId: AgentId;
    readonly config: ResolvedWorkspaceConfig;
  }[];
  readonly disposed: readonly WorkspaceId[];
} {
  const created: { readonly agentId: AgentId; readonly config: ResolvedWorkspaceConfig }[] = [];
  const disposed: WorkspaceId[] = [];
  return {
    name: "test-worktree",
    isSandboxed: true,
    created,
    disposed,
    create: async (agent, config): Promise<Result<WorkspaceInfo, KoiError>> => {
      created.push({ agentId: agent, config });
      const id = workspaceId(`ws-${created.length}`);
      return {
        ok: true,
        value: {
          id,
          path: `/tmp/${id}`,
          createdAt: created.length,
          metadata: { agentId: agent },
        },
      };
    },
    dispose: async (id): Promise<Result<void, KoiError>> => {
      disposed.push(id);
      return { ok: true, value: undefined };
    },
    isHealthy: () => true,
  };
}

describe("createRemoteGatewayStack", () => {
  test("composes remote auth, gateway stack, and session bridge lifecycle", async () => {
    const gateway = makeGateway();
    const stopCalls: string[] = [];
    const stack: GatewayStack = {
      gateway,
      canvas: undefined,
      webhook: undefined,
      nexus: undefined,
      health: async () => ({
        status: "ok",
        gateway: { activeConnections: 0 },
        components: { gateway: true, canvas: false, webhook: false, nexus: false },
      }),
      healthHandler: async () => new Response("{}"),
      start: async () => {
        stopCalls.push("start");
      },
      stop: async () => {
        stopCalls.push("stack");
      },
    };
    const bridge = {
      dispose: async () => {
        stopCalls.push("bridge");
      },
    };
    const authenticator = createRemoteGatewayAuthenticator({
      authenticateRemote: async () => ({
        ok: true,
        subject: "subject",
        deviceId: "device",
        permissions: [],
        metadata: {},
      }),
      url: "wss://unused.example.test",
    });
    const remoteConfig = { url: "wss://remote.example.test/session" };
    const workspaceConfig: ResolvedWorkspaceConfig = {
      cleanupPolicy: "never",
      cleanupTimeoutMs: 1_000,
    };
    const transport = makeTransport();
    const workspace = makeWorkspaceBackend();
    const createRuntime = async () => ({
      runFrame: async () => {},
      dispose: async () => {},
    });
    let receivedRemoteConfig: unknown;
    let receivedStackConfig: unknown;
    let receivedStackDeps: GatewayStackDeps | undefined;
    let receivedBridgeConfig: RemoteSessionBridgeConfig | undefined;
    const internals: RemoteGatewayStackInternals = {
      createRemoteGatewayAuthenticator: (config) => {
        receivedRemoteConfig = config;
        return authenticator;
      },
      createGatewayStack: (config, deps) => {
        receivedStackConfig = config;
        receivedStackDeps = deps;
        return stack;
      },
      attachRemoteSessionBridge: (config) => {
        receivedBridgeConfig = config;
        return bridge;
      },
    };

    const remoteStack = createRemoteGatewayStack(
      { gateway: { maxConnections: 7 }, remote: remoteConfig, workspaceConfig },
      { transport, workspace, createRuntime },
      internals,
    );

    expect(remoteStack.gateway).toBe(gateway);
    expect(remoteStack.remoteBridge).toBe(bridge);
    expect(receivedRemoteConfig).toBe(remoteConfig);
    expect(receivedStackConfig).toEqual({ gateway: { maxConnections: 7 } });
    expect(receivedStackDeps?.transport).toBe(transport);
    expect(receivedStackDeps?.auth).toBe(authenticator);
    expect(receivedBridgeConfig).toEqual({
      gateway,
      workspace,
      workspaceConfig,
      createRuntime,
    });

    await remoteStack.stop();
    expect(stopCalls).toEqual(["bridge", "stack"]);
  });

  test("preserves both remote bridge and gateway stack stop failures", async () => {
    const gateway = makeGateway();
    const stack: GatewayStack = {
      gateway,
      canvas: undefined,
      webhook: undefined,
      nexus: undefined,
      health: async () => ({
        status: "ok",
        gateway: { activeConnections: 0 },
        components: { gateway: true, canvas: false, webhook: false, nexus: false },
      }),
      healthHandler: async () => new Response("{}"),
      start: async () => {},
      stop: async () => {
        throw new Error("stack stop failed");
      },
    };
    const bridge = {
      dispose: async () => {
        throw new Error("bridge stop failed");
      },
    };
    const authenticator = createRemoteGatewayAuthenticator({
      authenticateRemote: async () => ({
        ok: true,
        subject: "subject",
        deviceId: "device",
        permissions: [],
        metadata: {},
      }),
      url: "wss://unused.example.test",
    });
    const internals: RemoteGatewayStackInternals = {
      createRemoteGatewayAuthenticator: () => authenticator,
      createGatewayStack: () => stack,
      attachRemoteSessionBridge: () => bridge,
    };

    const remoteStack = createRemoteGatewayStack(
      { gateway: {}, remote: { url: "wss://remote.example.test/session" } },
      {
        transport: makeTransport(),
        workspace: makeWorkspaceBackend(),
        createRuntime: async () => ({
          runFrame: async () => {},
          dispose: async () => {},
        }),
      },
      internals,
    );

    await expect(remoteStack.stop()).rejects.toThrow(AggregateError);
  });
});

describe("createRemoteGatewayAuthenticator", () => {
  test("maps accepted remote auth into a gateway session identity", async () => {
    const auth = createRemoteGatewayAuthenticator({
      authenticateRemote: async () => ({
        ok: true,
        subject: "user-1",
        deviceId: "device-1",
        agentId: "agent-remote",
        permissions: [],
        metadata: { plan: "team" },
      }),
      url: "wss://gateway.example.test/session",
    });

    const result = await auth.authenticate({
      kind: "connect",
      minProtocol: 1,
      maxProtocol: 1,
      auth: { token: "token" },
      client: { id: "device-client" },
    });

    expect(result).toEqual({
      ok: true,
      sessionId: "remote:user-1:device-1",
      agentId: "agent-remote",
      metadata: {
        remoteSubject: "user-1",
        remoteDeviceId: "device-1",
        remotePermissions: [],
        remoteMetadata: { plan: "team" },
      },
      routing: { peer: "device-client" },
    });
  });
});

describe("createGatewayRemoteSessionRuntime", () => {
  test("runs request frames through the engine and sends a gateway response", async () => {
    const gateway = makeGateway();
    const inputs: EngineInput[] = [];
    const runtime = createGatewayRemoteSessionRuntime({
      gateway,
      runtime: {
        run: (input) => {
          inputs.push(input);
          return events([
            { kind: "text_delta", delta: "hello " },
            { kind: "text_delta", delta: "remote" },
            { kind: "done", output: doneOutput("completed") },
          ]);
        },
      },
      nextFrameId: () => "response-1",
      nowMs: () => 9_000,
    });
    const session = makeSession("session-engine", "agent-engine");

    runtime.runFrame(session, makeFrame(7, { text: "please answer" }));

    await waitFor(() => inputs.length === 1 && gateway.sent.length === 1);
    expect(inputs).toHaveLength(1);
    const input = inputs[0];
    expect(input).toEqual({
      kind: "messages",
      messages: [
        {
          senderId: "agent-engine",
          threadId: "session-engine",
          timestamp: 2_007,
          content: [{ kind: "text", text: "please answer" }],
          metadata: {
            source: "remote-gateway",
            frameId: "frame-7",
            frameKind: "request",
            sessionMetadata: {},
          },
        },
      ],
      signal: expect.any(AbortSignal),
    });
    expect(gateway.sent).toEqual([
      {
        agentId: "agent-engine",
        sessionId: "session-engine",
        frame: {
          kind: "response",
          id: "response-1",
          ref: "frame-7",
          seq: 0,
          timestamp: 9_000,
          payload: {
            text: "hello remote",
            stopReason: "completed",
            metrics: doneOutput("completed").metrics,
          },
        },
      },
    ]);
  });

  test("normalizes an absent payload to an empty prompt string", async () => {
    const gateway = makeGateway();
    const inputs: EngineInput[] = [];
    const runtime = createGatewayRemoteSessionRuntime({
      gateway,
      runtime: {
        run: (input) => {
          inputs.push(input);
          return events([{ kind: "done", output: doneOutput("completed") }]);
        },
      },
    });

    runtime.runFrame(makeSession("session-empty-payload"), {
      kind: "request",
      id: "frame-empty-payload",
      seq: 0,
      payload: undefined,
      timestamp: 2_000,
    });

    await waitFor(() => inputs.length === 1);
    expect(firstMessageContent(inputs)).toEqual([{ kind: "text", text: "" }]);
  });

  test("preserves explicit empty string prompt fields", async () => {
    const gateway = makeGateway();
    const inputs: EngineInput[] = [];
    const runtime = createGatewayRemoteSessionRuntime({
      gateway,
      runtime: {
        run: (input) => {
          inputs.push(input);
          return events([{ kind: "done", output: doneOutput("completed") }]);
        },
      },
    });

    runtime.runFrame(makeSession("session-empty-text"), makeFrame(0, { text: "" }));

    await waitFor(() => inputs.length === 1);
    expect(firstMessageContent(inputs)).toEqual([{ kind: "text", text: "" }]);
  });

  test("preserves explicit empty text content blocks", async () => {
    const gateway = makeGateway();
    const inputs: EngineInput[] = [];
    const runtime = createGatewayRemoteSessionRuntime({
      gateway,
      runtime: {
        run: (input) => {
          inputs.push(input);
          return events([{ kind: "done", output: doneOutput("completed") }]);
        },
      },
    });

    runtime.runFrame(
      makeSession("session-empty-content-block"),
      makeFrame(0, { content: [{ text: "" }] }),
    );

    await waitFor(() => inputs.length === 1);
    expect(firstMessageContent(inputs)).toEqual([{ kind: "text", text: "" }]);
  });

  test("normalizes non-json programmatic payloads without failing the request", async () => {
    const gateway = makeGateway();
    const inputs: EngineInput[] = [];
    const runtime = createGatewayRemoteSessionRuntime({
      gateway,
      runtime: {
        run: (input) => {
          inputs.push(input);
          return events([{ kind: "done", output: doneOutput("completed") }]);
        },
      },
    });

    runtime.runFrame(makeSession("session-bigint-payload"), makeFrame(0, 1n));

    await waitFor(() => inputs.length === 1);
    expect(firstMessageContent(inputs)).toEqual([{ kind: "text", text: "1" }]);
  });

  test("sends an error frame when the engine run fails", async () => {
    const gateway = makeGateway();
    const errors: unknown[] = [];
    const runtime = createGatewayRemoteSessionRuntime({
      gateway,
      runtime: {
        run: () => {
          throw new Error("model offline");
        },
      },
      nextFrameId: () => "error-1",
      nowMs: () => 10_000,
      onRuntimeError: (error) => {
        errors.push(error);
      },
    });

    runtime.runFrame(makeSession("session-error"), makeFrame(0));
    await waitFor(() => gateway.sent.length === 1);
    expect(gateway.sent).toEqual([
      {
        agentId: "agent-1",
        sessionId: "session-error",
        frame: {
          kind: "error",
          id: "error-1",
          ref: "frame-0",
          seq: 0,
          timestamp: 10_000,
          payload: { code: "RUNTIME_ERROR", message: "model offline" },
        },
      },
    ]);
    expect(errors).toHaveLength(1);
  });

  test("sends an error frame when the engine reports an error terminal", async () => {
    const gateway = makeGateway();
    const runtime = createGatewayRemoteSessionRuntime({
      gateway,
      runtime: {
        run: () =>
          events([
            { kind: "text_delta", delta: "partial" },
            {
              kind: "done",
              output: {
                ...doneOutput("error"),
                content: [{ kind: "text", text: "runtime failed" }],
              },
            },
          ]),
      },
      nextFrameId: () => "terminal-error-1",
      nowMs: () => 10_500,
    });

    runtime.runFrame(makeSession("session-terminal-error"), makeFrame(0));
    await waitFor(() => gateway.sent.length === 1);
    expect(gateway.sent).toEqual([
      {
        agentId: "agent-1",
        sessionId: "session-terminal-error",
        frame: {
          kind: "error",
          id: "terminal-error-1",
          ref: "frame-0",
          seq: 0,
          timestamp: 10_500,
          payload: { code: "RUNTIME_ERROR", message: "runtime failed" },
        },
      },
    ]);
  });

  test("aborts an in-flight request and sends a cancellation error frame", async () => {
    const gateway = makeGateway();
    let signal: AbortSignal | undefined;
    const runtime = createGatewayRemoteSessionRuntime({
      gateway,
      runtime: {
        run: async function* (input) {
          signal = input.signal;
          await new Promise<void>((resolve) => {
            input.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      },
      nextFrameId: () => "cancel-error-1",
      nowMs: () => 11_000,
    });
    const session = makeSession("session-cancel");

    runtime.runFrame(session, makeFrame(0, { text: "long task" }));
    await waitFor(() => signal !== undefined);
    runtime.runFrame(session, makeFrame(1, { kind: "cancel", requestId: "frame-0" }));
    await waitFor(() => signal?.aborted === true);

    expect(signal?.aborted).toBe(true);
    expect(gateway.sent).toEqual([
      {
        agentId: "agent-1",
        sessionId: "session-cancel",
        frame: {
          kind: "error",
          id: "cancel-error-1",
          ref: "frame-0",
          seq: 0,
          timestamp: 11_000,
          payload: { code: "CANCELLED", message: "Request cancelled" },
        },
      },
    ]);
  });

  test("sends only one cancellation error for repeated cancel frames", async () => {
    const gateway = makeGateway();
    let signal: AbortSignal | undefined;
    const runtime = createGatewayRemoteSessionRuntime({
      gateway,
      runtime: {
        run: async function* (input) {
          signal = input.signal;
          await new Promise<void>(() => {});
        },
      },
      nextFrameId: () => `cancel-error-${gateway.sent.length + 1}`,
      nowMs: () => 11_500,
    });
    const session = makeSession("session-repeat-cancel");

    runtime.runFrame(session, makeFrame(0, { text: "long task" }));
    await waitFor(() => signal !== undefined);
    runtime.runFrame(session, makeFrame(1, { kind: "cancel", requestId: "frame-0" }));
    runtime.runFrame(session, makeFrame(2, { kind: "cancel", requestId: "frame-0" }));

    expect(signal?.aborted).toBe(true);
    expect(gateway.sent).toHaveLength(1);
    expect(gateway.sent[0]?.frame.ref).toBe("frame-0");
  });

  test("does not start a second engine run for a duplicate active request frame", async () => {
    const gateway = makeGateway();
    let runs = 0;
    let releaseRun: (() => void) | undefined;
    const runtime = createGatewayRemoteSessionRuntime({
      gateway,
      runtime: {
        run: async function* () {
          runs += 1;
          await new Promise<void>((resolve) => {
            releaseRun = resolve;
          });
          yield { kind: "done", output: doneOutput("completed") };
        },
      },
      nextFrameId: () => "response-dedupe",
      nowMs: () => 12_000,
    });
    const session = makeSession("session-dedupe-active");
    const frame = makeFrame(0, { text: "long task" });

    runtime.runFrame(session, frame);
    await waitFor(() => runs === 1);
    runtime.runFrame(session, frame);
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseRun?.();

    await waitFor(() => gateway.sent.length === 1);
    expect(runs).toBe(1);
    expect(gateway.sent).toHaveLength(1);
  });

  test("disposes the underlying runtime before waiting for active runs to settle", async () => {
    const gateway = makeGateway();
    let signal: AbortSignal | undefined;
    let releaseRun: (() => void) | undefined;
    let disposed = false;
    const runtime = createGatewayRemoteSessionRuntime({
      gateway,
      runtime: {
        run: async function* (input) {
          signal = input.signal;
          await new Promise<void>((resolve) => {
            releaseRun = resolve;
          });
        },
        dispose: async () => {
          disposed = true;
          releaseRun?.();
        },
      },
    });

    runtime.runFrame(makeSession("session-dispose-active"), makeFrame(0, { text: "long task" }));
    await waitFor(() => signal !== undefined);
    await runtime.dispose();

    expect(signal?.aborted).toBe(true);
    expect(disposed).toBe(true);
    expect(gateway.sent).toEqual([]);
  });
});

describe("attachRemoteSessionBridge", () => {
  test("spawns one worktree-isolated runtime per session and reuses it after reconnect", async () => {
    const gateway = makeGateway();
    const workspace = makeWorkspaceBackend();
    const runs: Array<{
      readonly sessionId: string;
      readonly frameId: string;
      readonly cwd: string;
    }> = [];
    let runtimeCreates = 0;
    let runtimeGateway: Gateway | undefined;

    const handle = attachRemoteSessionBridge({
      gateway,
      workspace,
      createRuntime: async ({ session, workspace: ws, gateway: inputGateway }) => {
        runtimeCreates += 1;
        runtimeGateway = inputGateway;
        return {
          runFrame: async (_session, frame) => {
            runs.push({ sessionId: session.id, frameId: frame.id, cwd: ws.path });
          },
          dispose: async () => {},
        };
      },
    });

    const first = makeSession("session-1");
    gateway.emitSession({ kind: "created", session: first });
    await gateway.emitFrame(first, makeFrame(0));

    const reconnected = { ...first, connectedAt: 2_000, lastHeartbeat: 2_000 };
    gateway.emitSession({ kind: "created", session: reconnected });
    await gateway.emitFrame(reconnected, makeFrame(1));

    expect(runtimeCreates).toBe(1);
    expect(runtimeGateway).toBe(gateway);
    expect(workspace.created).toHaveLength(1);
    expect(workspace.created[0]?.agentId).toBe(agentId("agent-1"));
    expect(runs).toEqual([
      { sessionId: "session-1", frameId: "frame-0", cwd: "/tmp/ws-1" },
      { sessionId: "session-1", frameId: "frame-1", cwd: "/tmp/ws-1" },
    ]);
    await handle.dispose();
  });

  test("keeps concurrent sessions in isolated worktrees", async () => {
    const gateway = makeGateway();
    const workspace = makeWorkspaceBackend();
    const runs: Array<{
      readonly sessionId: string;
      readonly frameId: string;
      readonly cwd: string;
    }> = [];

    attachRemoteSessionBridge({
      gateway,
      workspace,
      createRuntime: async ({ workspace: ws }) => ({
        runFrame: async (session, frame) => {
          runs.push({ sessionId: session.id, frameId: frame.id, cwd: ws.path });
        },
        dispose: async () => {},
      }),
    });

    const first = makeSession("session-a", "agent-a");
    const second = makeSession("session-b", "agent-b");
    gateway.emitSession({ kind: "created", session: first });
    gateway.emitSession({ kind: "created", session: second });

    await Promise.all([
      gateway.emitFrame(first, makeFrame(0, "first")),
      gateway.emitFrame(second, makeFrame(0, "second")),
    ]);

    expect(workspace.created).toHaveLength(2);
    expect(workspace.created.map((entry) => entry.agentId)).toEqual([
      agentId("agent-a"),
      agentId("agent-b"),
    ]);
    expect(runs).toContainEqual({ sessionId: "session-a", frameId: "frame-0", cwd: "/tmp/ws-1" });
    expect(runs).toContainEqual({ sessionId: "session-b", frameId: "frame-0", cwd: "/tmp/ws-2" });
  });

  test("ignores non-request frames without spawning a runtime", async () => {
    const gateway = makeGateway();
    const workspace = makeWorkspaceBackend();
    let runtimeCreates = 0;

    attachRemoteSessionBridge({
      gateway,
      workspace,
      createRuntime: async () => {
        runtimeCreates += 1;
        return {
          runFrame: async () => {},
          dispose: async () => {},
        };
      },
    });

    const session = makeSession("session-event-frame");
    gateway.emitSession({ kind: "created", session });
    await gateway.emitFrame(session, {
      ...makeFrame(0, { text: "not user input" }),
      kind: "event",
    });

    expect(runtimeCreates).toBe(0);
    expect(workspace.created).toHaveLength(0);
  });

  test("retains a spawned runtime across disconnect and disposes it on destroy", async () => {
    const gateway = makeGateway();
    const workspace = makeWorkspaceBackend();
    let runtimeCreates = 0;
    let runtimeDisposes = 0;

    attachRemoteSessionBridge({
      gateway,
      workspace,
      createRuntime: async () => {
        runtimeCreates += 1;
        return {
          runFrame: async () => {},
          dispose: async () => {
            runtimeDisposes += 1;
          },
        };
      },
    });

    const session = makeSession("session-reconnect");
    gateway.emitSession({ kind: "created", session });
    await gateway.emitFrame(session, makeFrame(0));
    gateway.emitSession({ kind: "disconnected", sessionId: session.id, reason: "network lost" });

    expect(runtimeCreates).toBe(1);
    expect(runtimeDisposes).toBe(0);
    expect(workspace.disposed).toEqual([]);

    gateway.emitSession({ kind: "destroyed", sessionId: session.id, reason: "client terminated" });
    await waitFor(() => runtimeDisposes === 1);
    expect(workspace.disposed).toEqual([workspaceId("ws-1")]);
  });

  test("unsubscribes an agent frame handler after its final session is destroyed", async () => {
    const gateway = makeGateway();
    const workspace = makeWorkspaceBackend();

    attachRemoteSessionBridge({
      gateway,
      workspace,
      createRuntime: async () => ({
        runFrame: async () => {},
        dispose: async () => {},
      }),
    });

    const first = makeSession("session-agent-first", "agent-shared");
    const second = makeSession("session-agent-second", "agent-shared");
    gateway.emitSession({ kind: "created", session: first });
    gateway.emitSession({ kind: "created", session: second });

    expect(gateway.registeredAgents()).toEqual(["agent-shared"]);

    gateway.emitSession({ kind: "destroyed", sessionId: first.id, reason: "done" });
    expect(gateway.registeredAgents()).toEqual(["agent-shared"]);

    gateway.emitSession({ kind: "destroyed", sessionId: second.id, reason: "done" });
    expect(gateway.registeredAgents()).toEqual([]);
  });

  test("terminates a session by disposing the runtime, workspace, and gateway session", async () => {
    const gateway = makeGateway();
    const workspace = makeWorkspaceBackend();
    let disposed = 0;

    attachRemoteSessionBridge({
      gateway,
      workspace,
      createRuntime: async () => ({
        runFrame: async () => {},
        dispose: async () => {
          disposed += 1;
        },
      }),
    });

    const session = makeSession("session-terminate");
    gateway.emitSession({ kind: "created", session });
    await gateway.emitFrame(session, makeFrame(0));
    await gateway.emitFrame(session, makeFrame(1, { operation: "terminate" }));

    expect(disposed).toBe(1);
    expect(workspace.disposed).toEqual([workspaceId("ws-1")]);
    expect(gateway.destroyed).toEqual(["session-terminate"]);
  });

  test("surfaces gateway destroy failures during termination", async () => {
    const gateway = makeGateway();
    const workspace = makeWorkspaceBackend();
    let disposed = 0;
    gateway.failDestroySession("gateway destroy failed");

    attachRemoteSessionBridge({
      gateway,
      workspace,
      createRuntime: async () => ({
        runFrame: async () => {},
        dispose: async () => {
          disposed += 1;
        },
      }),
    });

    const session = makeSession("session-destroy-fail-terminate");
    gateway.emitSession({ kind: "created", session });
    await gateway.emitFrame(session, makeFrame(0));

    await expect(gateway.emitFrame(session, makeFrame(1, { kind: "terminate" }))).rejects.toThrow(
      /gateway destroy failed/,
    );
    expect(disposed).toBe(1);
    expect(workspace.disposed).toEqual([workspaceId("ws-1")]);
    expect(gateway.destroyed).toEqual([]);
  });

  test("preserves both runtime disposal and gateway destroy failures during termination", async () => {
    const gateway = makeGateway();
    const workspace = makeWorkspaceBackend();
    gateway.failDestroySession("gateway destroy failed");

    attachRemoteSessionBridge({
      gateway,
      workspace,
      createRuntime: async () => ({
        runFrame: async () => {},
        dispose: async () => {
          throw new Error("runtime dispose failed");
        },
      }),
    });

    const session = makeSession("session-dispose-destroy-fail");
    gateway.emitSession({ kind: "created", session });
    await gateway.emitFrame(session, makeFrame(0));

    await expect(gateway.emitFrame(session, makeFrame(1, { kind: "terminate" }))).rejects.toThrow(
      AggregateError,
    );
    expect(workspace.disposed).toEqual([workspaceId("ws-1")]);
    expect(gateway.destroyed).toEqual([]);
  });

  test("still disposes the workspace when runtime disposal fails", async () => {
    const gateway = makeGateway();
    const workspace = makeWorkspaceBackend();

    attachRemoteSessionBridge({
      gateway,
      workspace,
      createRuntime: async () => ({
        runFrame: async () => {},
        dispose: async () => {
          throw new Error("runtime dispose failed");
        },
      }),
    });

    const session = makeSession("session-cleanup-fail");
    gateway.emitSession({ kind: "created", session });
    await gateway.emitFrame(session, makeFrame(0));

    await expect(gateway.emitFrame(session, makeFrame(1, { kind: "terminate" }))).rejects.toThrow(
      /runtime dispose failed/,
    );
    expect(workspace.disposed).toEqual([workspaceId("ws-1")]);
    expect(gateway.destroyed).toEqual(["session-cleanup-fail"]);
  });

  test("surfaces workspace disposal failures during termination", async () => {
    const gateway = makeGateway();
    const created: AgentId[] = [];
    const workspace: WorkspaceBackend = {
      name: "dispose-fail",
      isSandboxed: true,
      create: async (agent): Promise<Result<WorkspaceInfo, KoiError>> => {
        created.push(agent);
        return {
          ok: true,
          value: {
            id: workspaceId("ws-dispose-fail"),
            path: "/tmp/ws-dispose-fail",
            createdAt: 1,
            metadata: { agentId: agent },
          },
        };
      },
      dispose: async () => ({
        ok: false,
        error: {
          code: "EXTERNAL",
          message: "workspace dispose failed",
          retryable: RETRYABLE_DEFAULTS.EXTERNAL,
        },
      }),
      isHealthy: () => true,
    };

    attachRemoteSessionBridge({
      gateway,
      workspace,
      createRuntime: async () => ({
        runFrame: async () => {},
        dispose: async () => {},
      }),
    });

    const session = makeSession("session-workspace-dispose-fail");
    gateway.emitSession({ kind: "created", session });
    await gateway.emitFrame(session, makeFrame(0));

    await expect(gateway.emitFrame(session, makeFrame(1, { kind: "terminate" }))).rejects.toThrow(
      /workspace dispose failed/,
    );
    expect(created).toEqual([agentId("agent-1")]);
    expect(gateway.destroyed).toEqual(["session-workspace-dispose-fail"]);
  });

  test("preserves both runtime and workspace disposal failures during termination", async () => {
    const gateway = makeGateway();
    const workspace: WorkspaceBackend = {
      name: "double-dispose-fail",
      isSandboxed: true,
      create: async (): Promise<Result<WorkspaceInfo, KoiError>> => ({
        ok: true,
        value: {
          id: workspaceId("ws-double-dispose-fail"),
          path: "/tmp/ws-double-dispose-fail",
          createdAt: 1,
          metadata: {},
        },
      }),
      dispose: async () => ({
        ok: false,
        error: {
          code: "EXTERNAL",
          message: "workspace dispose failed",
          retryable: RETRYABLE_DEFAULTS.EXTERNAL,
        },
      }),
      isHealthy: () => true,
    };

    attachRemoteSessionBridge({
      gateway,
      workspace,
      createRuntime: async () => ({
        runFrame: async () => {},
        dispose: async () => {
          throw new Error("runtime dispose failed");
        },
      }),
    });

    const session = makeSession("session-double-dispose-fail");
    gateway.emitSession({ kind: "created", session });
    await gateway.emitFrame(session, makeFrame(0));

    await expect(gateway.emitFrame(session, makeFrame(1, { kind: "terminate" }))).rejects.toThrow(
      AggregateError,
    );
    expect(gateway.destroyed).toEqual(["session-double-dispose-fail"]);
  });

  test("reports destroyed-session disposal failures without rejecting the event handler", async () => {
    const gateway = makeGateway();
    const workspace = makeWorkspaceBackend();
    const bridgeErrors: Array<{
      readonly message: string;
      readonly operation: string;
      readonly sessionId: string;
    }> = [];

    attachRemoteSessionBridge({
      gateway,
      workspace,
      createRuntime: async () => ({
        runFrame: async () => {},
        dispose: async () => {
          throw new Error("destroy cleanup failed");
        },
      }),
      onBridgeError: (error, context) => {
        bridgeErrors.push({
          message: error instanceof Error ? error.message : String(error),
          operation: context.operation,
          sessionId: context.sessionId,
        });
      },
    });

    const session = makeSession("session-destroy-fail");
    gateway.emitSession({ kind: "created", session });
    await gateway.emitFrame(session, makeFrame(0));
    gateway.emitSession({ kind: "destroyed", sessionId: session.id, reason: "test" });

    await waitFor(() => bridgeErrors.length === 1);
    expect(workspace.disposed).toEqual([workspaceId("ws-1")]);
    expect(bridgeErrors).toEqual([
      {
        message: "destroy cleanup failed",
        operation: "dispose.destroyed-session",
        sessionId: "session-destroy-fail",
      },
    ]);
  });

  test("aggregates multiple session disposal failures when bridge is disposed", async () => {
    const gateway = makeGateway();
    const workspace = makeWorkspaceBackend();

    const handle = attachRemoteSessionBridge({
      gateway,
      workspace,
      createRuntime: async ({ session }) => ({
        runFrame: async () => {},
        dispose: async () => {
          throw new Error(`runtime dispose failed: ${session.id}`);
        },
      }),
    });

    const first = makeSession("session-dispose-a", "agent-a");
    const second = makeSession("session-dispose-b", "agent-b");
    gateway.emitSession({ kind: "created", session: first });
    gateway.emitSession({ kind: "created", session: second });
    await gateway.emitFrame(first, makeFrame(0));
    await gateway.emitFrame(second, makeFrame(0));

    await expect(handle.dispose()).rejects.toThrow(AggregateError);
    expect(workspace.disposed).toEqual([workspaceId("ws-1"), workspaceId("ws-2")]);
  });

  test("fails closed when workspace creation fails", async () => {
    const gateway = makeGateway();
    const failingWorkspace: WorkspaceBackend = {
      name: "failing",
      isSandboxed: true,
      create: async () => ({
        ok: false,
        error: {
          code: "EXTERNAL",
          message: "worktree unavailable",
          retryable: RETRYABLE_DEFAULTS.EXTERNAL,
        },
      }),
      dispose: async () => ({ ok: true, value: undefined }),
      isHealthy: () => true,
    };

    attachRemoteSessionBridge({
      gateway,
      workspace: failingWorkspace,
      createRuntime: async () => {
        throw new Error("runtime should not be created");
      },
    });

    const session = makeSession("session-fail");
    gateway.emitSession({ kind: "created", session });
    await expect(gateway.emitFrame(session, makeFrame(0))).rejects.toThrow(/worktree unavailable/);
    expect(gateway.destroyed).toEqual(["session-fail"]);
  });

  test("preserves both runtime creation and gateway destroy failures", async () => {
    const gateway = makeGateway();
    const workspace = makeWorkspaceBackend();
    gateway.failDestroySession("spawn destroy failed");

    attachRemoteSessionBridge({
      gateway,
      workspace,
      createRuntime: async () => {
        throw new Error("runtime spawn failed");
      },
    });

    const session = makeSession("session-spawn-destroy-fail");
    gateway.emitSession({ kind: "created", session });

    await expect(gateway.emitFrame(session, makeFrame(0))).rejects.toThrow(AggregateError);
    expect(workspace.disposed).toEqual([workspaceId("ws-1")]);
    expect(gateway.destroyed).toEqual([]);
  });

  test("preserves both runtime creation and workspace cleanup failures", async () => {
    const gateway = makeGateway();
    const workspace: WorkspaceBackend = {
      name: "spawn-cleanup-fail",
      isSandboxed: true,
      create: async (): Promise<Result<WorkspaceInfo, KoiError>> => ({
        ok: true,
        value: {
          id: workspaceId("ws-spawn-cleanup-fail"),
          path: "/tmp/ws-spawn-cleanup-fail",
          createdAt: 1,
          metadata: {},
        },
      }),
      dispose: async () => ({
        ok: false,
        error: {
          code: "EXTERNAL",
          message: "workspace cleanup failed",
          retryable: RETRYABLE_DEFAULTS.EXTERNAL,
        },
      }),
      isHealthy: () => true,
    };

    attachRemoteSessionBridge({
      gateway,
      workspace,
      createRuntime: async () => {
        throw new Error("runtime spawn failed");
      },
    });

    const session = makeSession("session-spawn-cleanup-fail");
    gateway.emitSession({ kind: "created", session });

    await expect(gateway.emitFrame(session, makeFrame(0))).rejects.toThrow(AggregateError);
    expect(gateway.destroyed).toEqual(["session-spawn-cleanup-fail"]);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1_000) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function firstMessageContent(
  inputs: readonly EngineInput[],
): Extract<EngineInput, { readonly kind: "messages" }>["messages"][number]["content"] {
  const input = inputs[0];
  if (input?.kind !== "messages") throw new Error("expected messages input");
  return input.messages[0]?.content ?? [];
}

async function* events(items: readonly EngineEvent[]): AsyncIterable<EngineEvent> {
  for (const item of items) yield item;
}

function doneOutput(
  stopReason: "completed" | "error",
): Extract<EngineEvent, { kind: "done" }>["output"] {
  return {
    stopReason,
    content: [],
    metrics: {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      turns: 1,
      durationMs: 1,
    },
  };
}
