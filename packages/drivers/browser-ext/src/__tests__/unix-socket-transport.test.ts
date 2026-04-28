import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { duplexPair } from "node:stream";
import type { DriverFrame } from "../native-host/driver-frame.js";
import { createFrameReader } from "../native-host/frame-reader.js";
import { createFrameWriter } from "../native-host/frame-writer.js";
import type {
  LoopbackServerLike,
  LoopbackUpgradeSocket,
  LoopbackWebSocketPeer,
  LoopbackWebSocketServerLike,
} from "../unix-socket-transport.js";
import { createDriverClient, wireLoopbackWebSocketBridge } from "../unix-socket-transport.js";

class FakeUpgradeSocket implements LoopbackUpgradeSocket {
  public writes: string[] = [];
  public destroyed = false;

  public write(data: string): void {
    this.writes.push(data);
  }

  public destroy(): void {
    this.destroyed = true;
  }
}

class FakeWebSocketPeer extends EventEmitter implements LoopbackWebSocketPeer {
  public readyState = 1;
  public sent: string[] = [];

  public send(data: string): void {
    this.sent.push(data);
  }

  public close(): void {
    this.readyState = 3;
    this.emit("close");
  }
}

class FakeServer extends EventEmitter implements LoopbackServerLike {
  public override on(
    event: "upgrade",
    listener: (request: IncomingMessage, socket: LoopbackUpgradeSocket, head: Buffer) => void,
  ): this {
    return super.on(event, listener);
  }
}

class FakeWebSocketServer implements LoopbackWebSocketServerLike {
  private readonly peer: LoopbackWebSocketPeer;

  public constructor(peer: LoopbackWebSocketPeer) {
    this.peer = peer;
  }

  public handleUpgrade(
    _request: IncomingMessage,
    _socket: LoopbackUpgradeSocket,
    _head: Buffer,
    callback: (socket: LoopbackWebSocketPeer) => void,
  ): void {
    callback(this.peer);
  }
}

describe("unix-socket transport", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "koi-browser-ext-transport-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("speaks DriverFrame length-prefixed JSON over the socket client", async () => {
    const [clientSide, serverSide] = duplexPair();
    let observedKind = "";

    const writer = createFrameWriter(serverSide);
    void (async () => {
      try {
        for await (const payload of createFrameReader(serverSide)) {
          const frame = JSON.parse(payload) as {
            readonly kind: string;
            readonly requestId?: string;
          };
          observedKind = frame.kind;
          if (frame.kind === "list_tabs") {
            await writer.write(
              JSON.stringify({ kind: "tabs", requestId: frame.requestId, tabs: [] }),
            );
          }
        }
      } catch {}
    })();

    const client = createDriverClient({
      connectSocket: () => clientSide,
    });
    await client.connect();
    const tabs = await client.listTabs();
    expect(observedKind).toBe("list_tabs");
    expect(tabs.tabs).toEqual([]);

    await client.close();
    serverSide.destroy();
  });

  test("loopback websocket handshake enforces auth and bridges CDP frames", async () => {
    let cdpFrameSeen = false;
    const frameHandlerRef: { current: ((frame: DriverFrame) => void) | null } = { current: null };

    const fakeServer = new FakeServer();
    const fakePeer = new FakeWebSocketPeer();
    const fakeWss = new FakeWebSocketServer(fakePeer);
    const bridge = wireLoopbackWebSocketBridge(
      {
        token: "secret-token",
        sessionId: "11111111-1111-1111-1111-111111111111",
        transport: {
          async sendCdpFrame(frame): Promise<void> {
            cdpFrameSeen = frame.kind === "cdp" && frame.id === 7;
          },
          subscribeFrames(listener): () => void {
            frameHandlerRef.current = listener;
            return () => {
              if (frameHandlerRef.current === listener) frameHandlerRef.current = null;
            };
          },
          async detach() {
            return { kind: "detach_ack" as const, sessionId: "", tabId: 0, ok: true };
          },
        },
      },
      fakeServer,
      fakeWss,
    );

    const unauthorizedSocket = new FakeUpgradeSocket();
    fakeServer.emit(
      "upgrade",
      {
        headers: {},
      } as IncomingMessage,
      unauthorizedSocket,
      Buffer.alloc(0),
    );
    expect(unauthorizedSocket.writes[0]).toContain("401");
    expect(unauthorizedSocket.destroyed).toBe(true);

    const authorizedSocket = new FakeUpgradeSocket();
    fakeServer.emit(
      "upgrade",
      {
        headers: { authorization: "Bearer secret-token" },
      } as IncomingMessage,
      authorizedSocket,
      Buffer.alloc(0),
    );

    fakePeer.emit("message", Buffer.from(JSON.stringify({ id: 7, method: "Target.getTargets" })));
    const handler = frameHandlerRef.current;
    if (handler === null) {
      throw new Error("expected frame handler to be installed");
    }
    handler({
      kind: "cdp_result",
      sessionId: "11111111-1111-1111-1111-111111111111",
      id: 7,
      result: { ok: true },
    });

    expect(cdpFrameSeen).toBe(true);
    expect(JSON.parse(fakePeer.sent[0] ?? "{}")).toMatchObject({ id: 7, result: { ok: true } });

    bridge.close();
  });
});
