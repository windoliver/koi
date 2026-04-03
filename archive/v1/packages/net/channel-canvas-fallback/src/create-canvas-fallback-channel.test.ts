/**
 * Tests for the canvas fallback channel decorator.
 */

import { describe, expect, mock, test } from "bun:test";
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ContentBlock,
  KoiError,
  OutboundMessage,
  Result,
} from "@koi/core";
import { createCanvasFallbackChannel } from "./create-canvas-fallback-channel.js";
import type { GatewayClient, SurfaceResult } from "./gateway-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCapabilities(supportsA2ui: boolean): ChannelCapabilities {
  return {
    text: true,
    images: false,
    files: false,
    buttons: false,
    audio: false,
    video: false,
    threads: false,
    supportsA2ui,
  };
}

function makeChannel(overrides?: Partial<ChannelAdapter>): ChannelAdapter {
  return {
    name: "test",
    capabilities: makeCapabilities(false),
    connect: mock(() => Promise.resolve()),
    disconnect: mock(() => Promise.resolve()),
    send: mock(() => Promise.resolve()),
    onMessage: mock(() => () => {}),
    sendStatus: mock(() => Promise.resolve()),
    ...overrides,
  };
}

function makeGatewayClient(overrides?: Partial<GatewayClient>): GatewayClient {
  return {
    createSurface: mock(() =>
      Promise.resolve({ ok: true, value: { surfaceId: "s1" } } as Result<SurfaceResult, KoiError>),
    ),
    updateSurface: mock(() =>
      Promise.resolve({ ok: true, value: { surfaceId: "s1" } } as Result<SurfaceResult, KoiError>),
    ),
    deleteSurface: mock(() =>
      Promise.resolve({ ok: true, value: true } as Result<boolean, KoiError>),
    ),
    computeSurfaceUrl: (id: string) => `http://gw/canvas/${id}`,
    ...overrides,
  };
}

const a2uiCreateBlock: ContentBlock = {
  kind: "custom",
  type: "a2ui:createSurface",
  data: { kind: "createSurface", surfaceId: "s1", title: "Dashboard" },
};

const a2uiUpdateBlock: ContentBlock = {
  kind: "custom",
  type: "a2ui:updateComponents",
  data: { kind: "updateComponents", surfaceId: "s1" },
};

const a2uiDataModelBlock: ContentBlock = {
  kind: "custom",
  type: "a2ui:updateDataModel",
  data: { kind: "updateDataModel", surfaceId: "s1" },
};

const a2uiDeleteBlock: ContentBlock = {
  kind: "custom",
  type: "a2ui:deleteSurface",
  data: { kind: "deleteSurface", surfaceId: "s1" },
};

const textBlock: ContentBlock = { kind: "text", text: "Hello" };
const imageBlock: ContentBlock = { kind: "image", url: "https://example.com/img.png" };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createCanvasFallbackChannel", () => {
  test("returns inner channel unchanged when supportsA2ui is true", () => {
    const inner = makeChannel({ capabilities: makeCapabilities(true) });
    const client = makeGatewayClient();
    const wrapped = createCanvasFallbackChannel(inner, { gatewayClient: client });
    expect(wrapped).toBe(inner);
  });

  test("passes through messages with no A2UI blocks", async () => {
    const inner = makeChannel();
    const client = makeGatewayClient();
    const wrapped = createCanvasFallbackChannel(inner, { gatewayClient: client });

    const message: OutboundMessage = { content: [textBlock, imageBlock] };
    await wrapped.send(message);

    expect(inner.send).toHaveBeenCalledTimes(1);
    expect(inner.send).toHaveBeenCalledWith(message);
  });

  test("replaces createSurface block with text link on success", async () => {
    const inner = makeChannel();
    const client = makeGatewayClient();
    const wrapped = createCanvasFallbackChannel(inner, { gatewayClient: client });

    const message: OutboundMessage = { content: [a2uiCreateBlock] };
    await wrapped.send(message);

    expect(client.createSurface).toHaveBeenCalledTimes(1);
    expect(inner.send).toHaveBeenCalledTimes(1);

    const sentMessage = (inner.send as ReturnType<typeof mock>).mock
      .calls[0]?.[0] as OutboundMessage;
    expect(sentMessage.content).toHaveLength(1);
    expect(sentMessage.content[0]?.kind).toBe("text");
    expect((sentMessage.content[0] as { readonly text: string }).text).toContain(
      "[Surface] Dashboard",
    );
    expect((sentMessage.content[0] as { readonly text: string }).text).toContain(
      "http://gw/canvas/s1",
    );
  });

  test("replaces createSurface block with degraded text on failure", async () => {
    const inner = makeChannel();
    const client = makeGatewayClient({
      createSurface: mock(() =>
        Promise.resolve({
          ok: false,
          error: { code: "EXTERNAL", message: "server error", retryable: true } as KoiError,
        } as Result<SurfaceResult, KoiError>),
      ),
    });
    const onGatewayError = mock(() => {});
    const wrapped = createCanvasFallbackChannel(inner, { gatewayClient: client, onGatewayError });

    await wrapped.send({ content: [a2uiCreateBlock] });

    expect(onGatewayError).toHaveBeenCalledTimes(1);
    const sentMessage = (inner.send as ReturnType<typeof mock>).mock
      .calls[0]?.[0] as OutboundMessage;
    expect((sentMessage.content[0] as { readonly text: string }).text).toContain("[Warning]");
  });

  test("handles updateComponents via updateSurface", async () => {
    const inner = makeChannel();
    const client = makeGatewayClient();
    const wrapped = createCanvasFallbackChannel(inner, { gatewayClient: client });

    await wrapped.send({ content: [a2uiUpdateBlock] });

    expect(client.updateSurface).toHaveBeenCalledTimes(1);
    const sentMessage = (inner.send as ReturnType<typeof mock>).mock
      .calls[0]?.[0] as OutboundMessage;
    expect((sentMessage.content[0] as { readonly text: string }).text).toContain("[Updated]");
  });

  test("handles updateDataModel via updateSurface", async () => {
    const inner = makeChannel();
    const client = makeGatewayClient();
    const wrapped = createCanvasFallbackChannel(inner, { gatewayClient: client });

    await wrapped.send({ content: [a2uiDataModelBlock] });

    expect(client.updateSurface).toHaveBeenCalledTimes(1);
    const sentMessage = (inner.send as ReturnType<typeof mock>).mock
      .calls[0]?.[0] as OutboundMessage;
    expect((sentMessage.content[0] as { readonly text: string }).text).toContain("[Data updated]");
  });

  test("handles deleteSurface", async () => {
    const inner = makeChannel();
    const client = makeGatewayClient();
    const wrapped = createCanvasFallbackChannel(inner, { gatewayClient: client });

    await wrapped.send({ content: [a2uiDeleteBlock] });

    expect(client.deleteSurface).toHaveBeenCalledTimes(1);
    const sentMessage = (inner.send as ReturnType<typeof mock>).mock
      .calls[0]?.[0] as OutboundMessage;
    expect((sentMessage.content[0] as { readonly text: string }).text).toContain("[Removed]");
  });

  test("only replaces A2UI blocks in mixed content", async () => {
    const inner = makeChannel();
    const client = makeGatewayClient();
    const wrapped = createCanvasFallbackChannel(inner, { gatewayClient: client });

    const message: OutboundMessage = { content: [textBlock, a2uiCreateBlock, imageBlock] };
    await wrapped.send(message);

    const sentMessage = (inner.send as ReturnType<typeof mock>).mock
      .calls[0]?.[0] as OutboundMessage;
    expect(sentMessage.content).toHaveLength(3);
    expect(sentMessage.content[0]).toEqual(textBlock);
    expect(sentMessage.content[1]?.kind).toBe("text");
    expect(sentMessage.content[2]).toEqual(imageBlock);
  });

  test("delegates connect to inner channel", async () => {
    const inner = makeChannel();
    const wrapped = createCanvasFallbackChannel(inner, { gatewayClient: makeGatewayClient() });
    await wrapped.connect();
    expect(inner.connect).toHaveBeenCalledTimes(1);
  });

  test("delegates disconnect to inner channel", async () => {
    const inner = makeChannel();
    const wrapped = createCanvasFallbackChannel(inner, { gatewayClient: makeGatewayClient() });
    await wrapped.disconnect();
    expect(inner.disconnect).toHaveBeenCalledTimes(1);
  });

  test("delegates onMessage to inner channel", () => {
    const inner = makeChannel();
    const wrapped = createCanvasFallbackChannel(inner, { gatewayClient: makeGatewayClient() });
    const handler = () => Promise.resolve();
    wrapped.onMessage(handler);
    expect(inner.onMessage).toHaveBeenCalledWith(handler);
  });

  test("delegates sendStatus to inner channel", async () => {
    const inner = makeChannel();
    const wrapped = createCanvasFallbackChannel(inner, { gatewayClient: makeGatewayClient() });
    const status = { kind: "processing" as const, turnIndex: 1 };
    await wrapped.sendStatus?.(status);
    expect(inner.sendStatus).toHaveBeenCalledWith(status);
  });

  test("preserves inner channel name and capabilities", () => {
    const inner = makeChannel({ name: "slack" });
    const wrapped = createCanvasFallbackChannel(inner, { gatewayClient: makeGatewayClient() });
    expect(wrapped.name).toBe("slack");
    expect(wrapped.capabilities).toBe(inner.capabilities);
  });

  test("onGatewayError callback is invoked with error and surfaceId", async () => {
    const inner = makeChannel();
    const client = makeGatewayClient({
      createSurface: mock(() =>
        Promise.resolve({
          ok: false,
          error: { code: "TIMEOUT", message: "timed out", retryable: true } as KoiError,
        } as Result<SurfaceResult, KoiError>),
      ),
    });
    const onGatewayError = mock(() => {});
    const wrapped = createCanvasFallbackChannel(inner, { gatewayClient: client, onGatewayError });

    await wrapped.send({ content: [a2uiCreateBlock] });

    expect(onGatewayError).toHaveBeenCalledTimes(1);
    expect(onGatewayError).toHaveBeenCalledWith(expect.objectContaining({ code: "TIMEOUT" }), "s1");
  });
});
