/**
 * Shared test utilities for @koi/gateway tests.
 */

import type { GatewayAuthenticator } from "../auth.js";
import type { Transport, TransportConnection, TransportHandler, TransportSendResult } from "../transport.js";
import type { AuthResult, ConnectFrame, GatewayFrame, Session } from "../types.js";

// ---------------------------------------------------------------------------
// waitForCondition
// ---------------------------------------------------------------------------

/**
 * Poll a predicate until it returns true, or throw after timeout.
 * Replaces raw `setTimeout` sleeps in tests with deterministic waits.
 */
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
// Mock Transport
// ---------------------------------------------------------------------------

export interface MockConnection extends TransportConnection {
  readonly sent: readonly string[];
  readonly closed: boolean;
  readonly closeCode: number | undefined;
  readonly closeReason: string | undefined;
}

export interface MockTransport extends Transport {
  /** Simulate a new connection opening. */
  readonly simulateOpen: (conn?: Partial<TransportConnection> & {
    readonly sendResult?: TransportSendResult;
  }) => MockConnection;
  /** Simulate receiving a message on a connection. */
  readonly simulateMessage: (connId: string, data: string) => void;
  /** Simulate a connection closing. */
  readonly simulateClose: (connId: string, code?: number, reason?: string) => void;
  /** Simulate drain event on a connection. */
  readonly simulateDrain: (connId: string) => void;
  /** Get a mock connection by ID. */
  readonly getConnection: (id: string) => MockConnection | undefined;
}

export function createMockTransport(): MockTransport {
  let handler: TransportHandler | undefined;
  const connections = new Map<string, MockConnection>();

  function createMockConnection(overrides?: Partial<TransportConnection> & {
    readonly sendResult?: TransportSendResult;
  }): MockConnection {
    const sentMessages: string[] = [];
    let isClosed = false;
    let cCode: number | undefined;
    let cReason: string | undefined;
    const fixedSendResult = overrides?.sendResult;

    const conn: MockConnection = {
      id: overrides?.id ?? crypto.randomUUID(),
      remoteAddress: overrides?.remoteAddress ?? "127.0.0.1",
      send(data: string) {
        if (isClosed) return 0;
        sentMessages.push(data);
        if (fixedSendResult !== undefined) return fixedSendResult;
        return data.length;
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

    simulateOpen(overrides?: Partial<TransportConnection> & {
      readonly sendResult?: TransportSendResult;
    }): MockConnection {
      const conn = createMockConnection(overrides);
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
// Test frame builder
// ---------------------------------------------------------------------------

let testSeqCounter = 0;

export function createTestFrame(overrides?: Partial<GatewayFrame>): GatewayFrame {
  const seq = testSeqCounter++;
  return {
    kind: "request",
    id: overrides?.id ?? crypto.randomUUID(),
    seq: overrides?.seq ?? seq,
    timestamp: overrides?.timestamp ?? Date.now(),
    payload: overrides?.payload ?? null,
    ...(overrides?.ref !== undefined ? { ref: overrides.ref } : {}),
    ...(overrides?.kind !== undefined ? { kind: overrides.kind } : {}),
  };
}

export function resetTestSeqCounter(): void {
  testSeqCounter = 0;
}

// ---------------------------------------------------------------------------
// Test session builder
// ---------------------------------------------------------------------------

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

export function createTestAuthenticator(
  result?: AuthResult,
  validateResult = true,
): GatewayAuthenticator {
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
    async validate(_sessionId: string): Promise<boolean> {
      return validateResult;
    },
  };
}

// ---------------------------------------------------------------------------
// Connect frame builder
// ---------------------------------------------------------------------------

/** Build a JSON-encoded connect frame string for tests (range format). */
export function createConnectMessage(
  token = "test-token",
  overrides?: Partial<Omit<ConnectFrame, "type">>,
): string {
  const frame: ConnectFrame = {
    type: "connect",
    minProtocol: overrides?.minProtocol ?? 1,
    maxProtocol: overrides?.maxProtocol ?? 1,
    auth: overrides?.auth ?? { token },
    ...(overrides?.client !== undefined ? { client: overrides.client } : {}),
  };
  return JSON.stringify(frame);
}

/** Build a JSON-encoded connect frame string in legacy format (single protocol field). */
export function createLegacyConnectMessage(
  token = "test-token",
  protocol = 1,
): string {
  return JSON.stringify({
    type: "connect",
    protocol,
    auth: { token },
  });
}
