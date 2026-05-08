import type { EngineEvent } from "@koi/core";
import { createRequestStream } from "./tui-request-stream.js";

export interface TuiGatewayClient {
  readonly connect: () => Promise<void>;
  readonly reconnect: () => Promise<void>;
  readonly noteRemoteSeq: (seq: number) => Promise<void>;
  readonly run: (input: {
    readonly text: string;
    readonly requestId: string;
  }) => AsyncIterable<EngineEvent>;
  readonly cancel: (requestId: string) => Promise<void>;
  readonly dispose: () => Promise<void>;
  readonly sessionId: () => string | undefined;
}

export interface TuiGatewayClientDeps {
  readonly gatewayUrl: string;
  readonly clientId: string;
  readonly authToken: string;
  readonly webSocketFactory?: ((url: string) => WebSocket) | undefined;
}

type GatewaySessionFrame = {
  readonly kind?: string;
  readonly payload?: {
    readonly sessionId?: string;
    readonly remoteSeq?: number;
  };
};

interface ClientState {
  ws: WebSocket | undefined;
  sessionId: string | undefined;
  lastRemoteSeq: number;
  nextSeq: number;
}

function sendConnectFrame(socket: WebSocket, deps: TuiGatewayClientDeps): void {
  socket.send(
    JSON.stringify({
      kind: "connect",
      minProtocol: 1,
      maxProtocol: 1,
      auth: { token: deps.authToken },
      client: { id: deps.clientId, version: "0.0.0", platform: "koi-tui" },
    }),
  );
}

function awaitAck(
  socket: WebSocket,
  state: ClientState,
  mode: "initial" | "resume",
  expectedSessionId: string | undefined,
  minimumRemoteSeq: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const failMsg = mode === "resume" ? "gateway resume failed" : "gateway connect failed";
    const settle = (err?: string): void => {
      if (settled) return;
      settled = true;
      err === undefined ? resolve() : reject(new Error(err));
    };

    socket.addEventListener("message", (event) => {
      const frame = parseSessionFrame(event.data);
      if (frame === undefined) return;
      const ackSessionId = frame.payload?.sessionId;
      if (ackSessionId === undefined) return;
      const ackRemoteSeq = frame.payload?.remoteSeq ?? 0;
      if (expectedSessionId !== undefined && ackSessionId !== expectedSessionId) {
        return settle("gateway resume failed: session identity changed");
      }
      if (expectedSessionId !== undefined && ackRemoteSeq < minimumRemoteSeq) {
        return settle("gateway resume failed: remote seq regressed");
      }
      state.sessionId = ackSessionId;
      if (ackRemoteSeq > state.lastRemoteSeq) state.lastRemoteSeq = ackRemoteSeq;
      settle();
    });
    socket.addEventListener("error", () => settle(failMsg));
    socket.addEventListener("close", () => settle(failMsg));
  });
}

function parseSessionFrame(data: unknown): GatewaySessionFrame | undefined {
  try {
    const frame = JSON.parse(String(data)) as GatewaySessionFrame;
    return frame.kind === "ack" ? frame : undefined;
  } catch {
    return undefined;
  }
}

async function connectSocket(
  state: ClientState,
  deps: TuiGatewayClientDeps,
  mode: "initial" | "resume",
): Promise<void> {
  const expectedSessionId = mode === "resume" ? state.sessionId : undefined;
  const minimumRemoteSeq = mode === "resume" ? state.lastRemoteSeq : 0;

  state.ws?.close();
  state.ws = (deps.webSocketFactory ?? ((url) => new WebSocket(url)))(deps.gatewayUrl);
  const socket = state.ws;

  const ackPromise = awaitAck(socket, state, mode, expectedSessionId, minimumRemoteSeq);
  if (socket.readyState === 1) {
    sendConnectFrame(socket, deps);
  } else {
    socket.addEventListener("open", () => sendConnectFrame(socket, deps));
  }
  await ackPromise;
}

function sendRequestFrame(state: ClientState, payload: unknown, id: string): void {
  if (state.ws === undefined || state.ws.readyState !== 1) {
    throw new Error("gateway socket is not connected");
  }
  state.ws.send(
    JSON.stringify({
      kind: "request",
      id,
      seq: state.nextSeq++,
      payload,
      timestamp: Date.now(),
    }),
  );
}

export function createTuiGatewayClient(deps: TuiGatewayClientDeps): TuiGatewayClient {
  const state: ClientState = {
    ws: undefined,
    sessionId: undefined,
    lastRemoteSeq: 0,
    nextSeq: 0,
  };

  return {
    connect: () => connectSocket(state, deps, "initial"),
    reconnect: () => connectSocket(state, deps, "resume"),
    noteRemoteSeq: async (seq) => {
      if (seq > state.lastRemoteSeq) state.lastRemoteSeq = seq;
    },
    run: (input) => {
      if (state.ws === undefined || state.ws.readyState !== 1) {
        throw new Error("gateway socket is not connected");
      }
      const stream = createRequestStream(state.ws, input.requestId);
      sendRequestFrame(state, { text: input.text }, input.requestId);
      return stream.iterator;
    },
    cancel: async (requestId) => {
      sendRequestFrame(state, { kind: "cancel", requestId }, crypto.randomUUID());
    },
    dispose: async () => {
      state.ws?.close();
      state.ws = undefined;
    },
    sessionId: () => state.sessionId,
  };
}
