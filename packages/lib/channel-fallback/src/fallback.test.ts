import { describe, expect, test } from "bun:test";
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ContentBlock,
  OutboundMessage,
  TextBlock,
} from "@koi/core";
import { wrapWithFallback } from "./fallback.js";

function makeInner(caps: ChannelCapabilities): {
  readonly inner: ChannelAdapter;
  readonly sent: OutboundMessage[];
} {
  const sent: OutboundMessage[] = [];
  const inner: ChannelAdapter = {
    name: "inner",
    capabilities: caps,
    connect: async () => {},
    disconnect: async () => {},
    send: async (msg) => {
      sent.push(msg);
    },
    onMessage: () => () => {},
  };
  return { inner, sent };
}

const TEXT_ONLY: ChannelCapabilities = {
  text: true,
  images: false,
  files: false,
  buttons: false,
  audio: false,
  video: false,
  threads: false,
  supportsA2ui: false,
};

const RICH: ChannelCapabilities = {
  text: true,
  images: true,
  files: true,
  buttons: true,
  audio: false,
  video: false,
  threads: false,
  supportsA2ui: true,
};

describe("wrapWithFallback", () => {
  test("preserves inner name + capabilities", () => {
    const { inner } = makeInner(TEXT_ONLY);
    const wrapped = wrapWithFallback(inner);
    expect(wrapped.name).toBe("inner");
    expect(wrapped.capabilities).toEqual(TEXT_ONLY);
  });

  test("text passes through unchanged", async () => {
    const { inner, sent } = makeInner(TEXT_ONLY);
    const wrapped = wrapWithFallback(inner);
    await wrapped.send({ content: [{ kind: "text", text: "hi" }] });
    expect(sent[0]?.content[0]).toEqual({ kind: "text", text: "hi" });
  });

  test("image downgrades when inner has no image support", async () => {
    const { inner, sent } = makeInner(TEXT_ONLY);
    const wrapped = wrapWithFallback(inner, { urlPrefix: "https://cdn/" });
    await wrapped.send({
      content: [{ kind: "image", url: "x.png", alt: "diagram" }],
    });
    const block = sent[0]?.content[0] as TextBlock;
    expect(block.kind).toBe("text");
    expect(block.text).toBe("[image: diagram](https://cdn/x.png)");
  });

  test("image passes through when inner supports images", async () => {
    const { inner, sent } = makeInner(RICH);
    const wrapped = wrapWithFallback(inner);
    const block: ContentBlock = { kind: "image", url: "x.png", alt: "d" };
    await wrapped.send({ content: [block] });
    expect(sent[0]?.content[0]).toEqual(block);
  });

  test("file downgrades when inner has no file support", async () => {
    const { inner, sent } = makeInner(TEXT_ONLY);
    const wrapped = wrapWithFallback(inner);
    await wrapped.send({
      content: [{ kind: "file", url: "report.pdf", mimeType: "application/pdf", name: "report" }],
    });
    expect((sent[0]?.content[0] as TextBlock).text).toBe("[file: report](report.pdf)");
  });

  test("button downgrades when inner has no button support", async () => {
    const { inner, sent } = makeInner(TEXT_ONLY);
    const wrapped = wrapWithFallback(inner);
    await wrapped.send({
      content: [{ kind: "button", label: "Approve", action: "approve" }],
    });
    expect((sent[0]?.content[0] as TextBlock).text).toBe("[Approve]");
  });

  test("custom downgrades to placeholder text by default", async () => {
    const { inner, sent } = makeInner(TEXT_ONLY);
    const wrapped = wrapWithFallback(inner);
    await wrapped.send({
      content: [{ kind: "custom", type: "chart", data: {} }],
    });
    expect((sent[0]?.content[0] as TextBlock).text).toBe("[custom: chart]");
  });

  test("custom dropped when dropCustom: true", async () => {
    const { inner, sent } = makeInner(TEXT_ONLY);
    const wrapped = wrapWithFallback(inner, { dropCustom: true });
    await wrapped.send({
      content: [
        { kind: "custom", type: "chart", data: {} },
        { kind: "text", text: "after" },
      ],
    });
    expect(sent[0]?.content).toHaveLength(1);
    expect((sent[0]?.content[0] as TextBlock).text).toBe("after");
  });

  test("connect/disconnect/onMessage delegate to inner", async () => {
    let connects = 0;
    let disconnects = 0;
    const inner: ChannelAdapter = {
      name: "inner",
      capabilities: TEXT_ONLY,
      connect: async () => {
        connects++;
      },
      disconnect: async () => {
        disconnects++;
      },
      send: async () => {},
      onMessage: () => () => {},
    };
    const wrapped = wrapWithFallback(inner);
    await wrapped.connect();
    await wrapped.disconnect();
    expect(connects).toBe(1);
    expect(disconnects).toBe(1);
  });
});
