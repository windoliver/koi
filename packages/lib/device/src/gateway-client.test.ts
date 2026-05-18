import { describe, expect, test } from "bun:test";
import { createDeviceGatewayClient } from "./gateway-client.js";
import { createCameraProvider, createLocationProvider } from "./provider.js";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readonly sent: string[] = [];
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances = [...FakeWebSocket.instances, this];
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.onclose?.(new CloseEvent("close"));
  }
}

function sentKinds(ws: FakeWebSocket): readonly string[] {
  return ws.sent.map((raw) => JSON.parse(raw).kind as string);
}

describe("createDeviceGatewayClient", () => {
  test("connects, advertises provider capabilities, heartbeats, updates, and reconnects", async () => {
    FakeWebSocket.instances = [];
    const client = createDeviceGatewayClient({
      gatewayUrl: "ws://gateway.test",
      nodeId: "device-1",
      providers: [createLocationProvider({}), createCameraProvider({})],
      heartbeatIntervalMs: 10,
      reconnectDelayMs: 1,
      webSocketFactory: (url) => new FakeWebSocket(url),
    });

    client.connect();
    const first = FakeWebSocket.instances[0];
    if (first === undefined) throw new Error("expected first websocket");
    first.onopen?.(new Event("open"));

    expect(sentKinds(first).slice(0, 2)).toEqual(["node:handshake", "node:capabilities"]);
    expect(JSON.parse(first.sent[1] ?? "{}").payload.tools).toEqual([
      { name: "device.location", description: "Device provider: device:location" },
      { name: "device.camera", description: "Device provider: device:camera" },
    ]);

    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(sentKinds(first)).toContain("node:heartbeat");

    client.updateProviders([createCameraProvider({})]);
    expect(JSON.parse(first.sent.at(-1) ?? "{}")).toMatchObject({
      kind: "node:tools_updated",
      payload: {
        added: [],
        removed: ["device.location"],
      },
    });

    first.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({
          kind: "node:capabilities_query",
          nodeId: "device-1",
          agentId: "",
          correlationId: "query-1",
          payload: null,
        }),
      }),
    );
    expect(JSON.parse(first.sent.at(-1) ?? "{}")).toMatchObject({
      kind: "node:capabilities",
      correlationId: "query-1",
      payload: {
        nodeType: "thin",
        tools: [{ name: "device.camera", description: "Device provider: device:camera" }],
      },
    });

    first.onclose?.(new CloseEvent("close"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = FakeWebSocket.instances[1];
    if (second === undefined) throw new Error("expected reconnect websocket");
    second.onopen?.(new Event("open"));
    expect(sentKinds(second).slice(0, 2)).toEqual(["node:handshake", "node:capabilities"]);

    client.disconnect();
  });
});
