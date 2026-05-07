import { describe, expect, test } from "bun:test";
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ContentBlock,
  InboundMessage,
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

  test("preserves adapter-specific extension methods (e.g. sendUnsolicited)", async () => {
    // Regression: round-8 collapsed to a bare ChannelAdapter and silently
    // stripped MobileChannelAdapter.sendUnsolicited. The wrapper is now
    // generic so caller-side extension methods survive composition.
    let unsolicitedCalls = 0;
    interface ExtendedAdapter extends ChannelAdapter {
      readonly sendUnsolicited: (m: { content: ContentBlock[] }) => Promise<void>;
    }
    const inner: ExtendedAdapter = {
      name: "extended",
      capabilities: TEXT_ONLY,
      connect: async () => {},
      disconnect: async () => {},
      send: async () => {},
      onMessage: () => () => {},
      sendUnsolicited: async () => {
        unsolicitedCalls++;
      },
    };
    const wrapped = wrapWithFallback(inner);
    expect(typeof wrapped.sendUnsolicited).toBe("function");
    await wrapped.sendUnsolicited({ content: [{ kind: "text", text: "hi" }] });
    expect(unsolicitedCalls).toBe(1);
  });

  test("sendUnsolicited extension method runs the same downgrade pass as send()", async () => {
    // Round-13 medium finding: preserving sendUnsolicited as a passthrough
    // bypassed the fallback downgrade — a host could wrap an adapter
    // expecting all outbound to be safe for a narrow channel, then call
    // sendUnsolicited() and push raw unsupported blocks anyway.
    const seen: OutboundMessage[] = [];
    interface ExtendedAdapter extends ChannelAdapter {
      readonly sendUnsolicited: (m: OutboundMessage) => Promise<void>;
    }
    const inner: ExtendedAdapter = {
      name: "extended",
      capabilities: TEXT_ONLY, // images/files/buttons NOT supported
      connect: async () => {},
      disconnect: async () => {},
      send: async () => {},
      onMessage: () => () => {},
      sendUnsolicited: async (m) => {
        seen.push(m);
      },
    };
    const wrapped = wrapWithFallback(inner);
    await wrapped.sendUnsolicited({
      content: [
        { kind: "image", url: "https://example.com/x.png", alt: "cat" },
        { kind: "button", label: "OK", action: "ok" },
        { kind: "text", text: "hello" },
      ],
    });
    expect(seen).toHaveLength(1);
    const out = seen[0]!.content;
    // All non-text blocks downgraded to text — none escaped raw.
    expect(out.every((b) => b.kind === "text")).toBe(true);
    expect((out[0] as TextBlock).text).toContain("[image: cat]");
    expect((out[1] as TextBlock).text).toBe("[OK]");
    expect((out[2] as TextBlock).text).toBe("hello");
  });

  test("forwards sendUnsolicited's optional opts (e.g. {recipient}) to inner (round-42 high)", async () => {
    // Round-42 high: prior proxy treated extension methods as
    // (message) => Promise<void> and silently dropped subsequent args.
    // MobileChannelAdapter.sendUnsolicited(message, {recipient}) uses the
    // second arg to safely route mismatched-live / offline sends through
    // pushNotifier — dropping it would break explicit recipient targeting.
    const seenOpts: Array<unknown> = [];
    interface ExtendedAdapter extends ChannelAdapter {
      readonly sendUnsolicited: (m: OutboundMessage, opts?: unknown) => Promise<void>;
    }
    const inner: ExtendedAdapter = {
      name: "extended",
      capabilities: TEXT_ONLY,
      connect: async () => {},
      disconnect: async () => {},
      send: async () => {},
      onMessage: () => () => {},
      sendUnsolicited: async (_m, opts) => {
        seenOpts.push(opts);
      },
    };
    const wrapped = wrapWithFallback(inner);
    await wrapped.sendUnsolicited(
      { content: [{ kind: "text", text: "hi" }] },
      { recipient: "device-alice" },
    );
    expect(seenOpts).toEqual([{ recipient: "device-alice" }]);
  });

  test("preserves prototype methods on class-backed adapters (round-39 regression)", async () => {
    // Round-39 medium: prior implementation used object spread which only
    // copies enumerable own properties. A class-backed ChannelAdapter whose
    // lifecycle methods (connect/disconnect/onMessage) live on the
    // prototype lost those methods entirely while the return type still
    // claimed the full adapter shape — silent runtime failure.
    let connects = 0;
    let disconnects = 0;
    let sends = 0;
    let listens = 0;
    class ClassAdapter implements ChannelAdapter {
      readonly name = "class-adapter";
      readonly capabilities = TEXT_ONLY;
      async connect(): Promise<void> {
        connects++;
      }
      async disconnect(): Promise<void> {
        disconnects++;
      }
      async send(_msg: OutboundMessage): Promise<void> {
        sends++;
      }
      onMessage(_h: (m: InboundMessage) => Promise<void>): () => void {
        listens++;
        return () => {};
      }
    }
    const inner = new ClassAdapter();
    const wrapped = wrapWithFallback(inner);
    expect(wrapped.name).toBe("class-adapter");
    expect(typeof wrapped.connect).toBe("function");
    expect(typeof wrapped.disconnect).toBe("function");
    expect(typeof wrapped.onMessage).toBe("function");
    await wrapped.connect();
    await wrapped.disconnect();
    await wrapped.send({ content: [{ kind: "text", text: "hi" }] });
    wrapped.onMessage(async () => {});
    expect(connects).toBe(1);
    expect(disconnects).toBe(1);
    expect(sends).toBe(1);
    expect(listens).toBe(1);
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
