/**
 * Shared test utilities for @koi/gateway.
 */

import type { KoiError, Result } from "@koi/core";
import type { GatewayAuthenticator } from "../auth.js";
import type { SessionStore } from "../session-store.js";
import type {
  Transport,
  TransportConnection,
  TransportHandler,
  TransportSendResult,
} from "../transport.js";
import type { AuthResult, ConnectFrame, GatewayFrame, Session } from "../types.js";

// ---------------------------------------------------------------------------
// waitForCondition
// ---------------------------------------------------------------------------

export async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 2000,
  intervalMs = 10,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitForCondition timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ---------------------------------------------------------------------------
// SessionStore helpers
// ---------------------------------------------------------------------------

export function storeHas(store: SessionStore, id: string): boolean {
  const r = store.has(id) as Result<boolean, KoiError>;
  return r.ok && r.value;
}

export function storeGet(store: SessionStore, id: string): Session | undefined {
  const r = store.get(id) as Result<Session, KoiError>;
  return r.ok ? r.value : undefined;
}

// ---------------------------------------------------------------------------
// MockTransport
// ---------------------------------------------------------------------------

export interface MockConnection extends TransportConnection {
  readonly sent: readonly string[];
  readonly closed: boolean;
  readonly closeCode: number | undefined;
  readonly closeReason: string | undefined;
}

export interface MockTransport extends Transport {
  readonly simulateOpen: (
    opts?: Partial<TransportConnection> & { readonly sendResult?: TransportSendResult },
  ) => MockConnection;
  readonly simulateMessage: (connId: string, data: string) => void;
  readonly simulateClose: (connId: string, code?: number, reason?: string) => void;
  readonly simulateDrain: (connId: string) => void;
  readonly getConnection: (id: string) => MockConnection | undefined;
}

export function createMockTransport(): MockTransport {
  let handler: TransportHandler | undefined;
  const connections = new Map<string, MockConnection>();

  function makeMockConn(
    opts?: Partial<TransportConnection> & { readonly sendResult?: TransportSendResult },
  ): MockConnection {
    const sentMessages: string[] = [];
    let isClosed = false;
    let cCode: number | undefined;
    let cReason: string | undefined;
    const fixedSendResult = opts?.sendResult;

    const conn: MockConnection = {
      id: opts?.id ?? crypto.randomUUID(),
      remoteAddress: opts?.remoteAddress ?? "127.0.0.1",
      send(data: string) {
        if (isClosed) return 0;
        sentMessages.push(data);
        return fixedSendResult !== undefined ? fixedSendResult : data.length;
      },
      close(code?: number, reason?: string) {
        isClosed = true;
        cCode = code;
        cReason = reason;
      },
      get sent() {
        return [...sentMessages];
      },
      get closed() {
        return isClosed;
      },
      get closeCode() {
        return cCode;
      },
      get closeReason() {
        return cReason;
      },
    };
    return conn;
  }

  return {
    async listen(_port: number, h: TransportHandler): Promise<void> {
      handler = h;
    },

    close(): void {
      handler = undefined;
      connections.clear();
    },

    connections(): number {
      return connections.size;
    },

    simulateOpen(opts) {
      const conn = makeMockConn(opts);
      connections.set(conn.id, conn);
      handler?.onOpen(conn);
      return conn;
    },

    simulateMessage(connId: string, data: string): void {
      const conn = connections.get(connId);
      if (conn === undefined) return;
      handler?.onMessage(conn, data);
    },

    simulateClose(connId: string, code = 1000, reason = ""): void {
      const conn = connections.get(connId);
      if (conn === undefined) return;
      connections.delete(connId);
      handler?.onClose(conn, code, reason);
    },

    simulateDrain(connId: string): void {
      const conn = connections.get(connId);
      if (conn === undefined) return;
      handler?.onDrain(conn);
    },

    getConnection(id: string): MockConnection | undefined {
      return connections.get(id);
    },
  };
}

// ---------------------------------------------------------------------------
// Frame/session builders
// ---------------------------------------------------------------------------

let testSeqCounter = 0;

export function resetTestSeqCounter(): void {
  testSeqCounter = 0;
}

export function createTestFrame(overrides?: Partial<GatewayFrame>): GatewayFrame {
  const seq = overrides?.seq ?? testSeqCounter++;
  return {
    kind: overrides?.kind ?? "request",
    id: overrides?.id ?? crypto.randomUUID(),
    seq,
    timestamp: overrides?.timestamp ?? Date.now(),
    payload: overrides?.payload ?? null,
    ...(overrides?.ref !== undefined ? { ref: overrides.ref } : {}),
  };
}

export function createTestSession(overrides?: Partial<Session>): Session {
  return {
    id: overrides?.id ?? crypto.randomUUID(),
    agentId: overrides?.agentId ?? "test-agent",
    connectedAt: overrides?.connectedAt ?? Date.now(),
    lastHeartbeat: overrides?.lastHeartbeat ?? Date.now(),
    seq: overrides?.seq ?? 0,
    remoteSeq: overrides?.remoteSeq ?? 0,
    metadata: overrides?.metadata ?? {},
    ...(overrides?.routing !== undefined ? { routing: overrides.routing } : {}),
  };
}

// ---------------------------------------------------------------------------
// Test authenticator
// ---------------------------------------------------------------------------

export function createTestAuthenticator(result?: AuthResult): GatewayAuthenticator {
  const defaultResult: AuthResult = result ?? {
    ok: true,
    sessionId: crypto.randomUUID(),
    agentId: "test-agent",
    metadata: {},
  };
  return {
    async authenticate(_frame: ConnectFrame): Promise<AuthResult> {
      return defaultResult;
    },
  };
}

// ---------------------------------------------------------------------------
// Connect frame builders
// ---------------------------------------------------------------------------

export function createConnectMessage(
  token = "test-token",
  overrides?: Partial<Omit<ConnectFrame, "kind">>,
): string {
  const frame: ConnectFrame = {
    kind: "connect",
    minProtocol: overrides?.minProtocol ?? 1,
    maxProtocol: overrides?.maxProtocol ?? 1,
    auth: overrides?.auth ?? { token },
    ...(overrides?.client !== undefined ? { client: overrides.client } : {}),
  };
  return JSON.stringify(frame);
}

export function createLegacyConnectMessage(token = "test-token", protocol = 1): string {
  return JSON.stringify({ kind: "connect", protocol, auth: { token } });
}
