import { describe, expect, test } from "bun:test";
import type { InboundMessage, TextBlock } from "@koi/core";
import { createVoiceChannel, type Stt, type Tts, type VoiceTransport } from "./voice-channel.js";

interface SentUtterance {
  readonly sessionId: string;
  readonly frames: readonly Uint8Array[];
}

interface Harness {
  readonly transport: VoiceTransport;
  readonly stt: Stt;
  readonly tts: Tts;
  readonly emitAudio: (frame: Uint8Array, sessionId?: string) => void;
  readonly sentUtterances: SentUtterance[];
  readonly sentAudio: Uint8Array[];
  readonly sttCalls: Uint8Array[];
  readonly ttsCalls: string[];
  connectCount: number;
  disconnectCount: number;
}

function harness(opts?: {
  readonly sttResult?: (audio: Uint8Array) => string | null;
  readonly ttsResult?: (text: string) => Uint8Array;
  readonly sendUtterance?: (sessionId: string, frames: readonly Uint8Array[]) => Promise<void>;
}): Harness {
  let listener: ((sessionId: string, frame: Uint8Array) => void) | undefined;
  const sentUtterances: SentUtterance[] = [];
  const sentAudio: Uint8Array[] = [];
  const sttCalls: Uint8Array[] = [];
  const ttsCalls: string[] = [];
  const h: Harness = {
    transport: {
      connect: async () => {
        h.connectCount++;
      },
      disconnect: async () => {
        h.disconnectCount++;
      },
      sendUtterance: async (sessionId, frames) => {
        if (opts?.sendUtterance) {
          await opts.sendUtterance(sessionId, frames);
        }
        sentUtterances.push({ sessionId, frames });
        for (const f of frames) sentAudio.push(f);
      },
      onUtterance: (handler) => {
        listener = handler;
        return () => {
          listener = undefined;
        };
      },
    },
    stt: {
      transcribe: async (audio) => {
        sttCalls.push(audio);
        return opts?.sttResult ? opts.sttResult(audio) : "hello";
      },
    },
    tts: {
      synthesize: async (text) => {
        ttsCalls.push(text);
        return opts?.ttsResult ? opts.ttsResult(text) : new Uint8Array([text.length]);
      },
    },
    emitAudio: (frame, sessionId = "session-1") => listener?.(sessionId, frame),
    sentUtterances,
    sentAudio,
    sttCalls,
    ttsCalls,
    connectCount: 0,
    disconnectCount: 0,
  };
  return h;
}

describe("createVoiceChannel config validation", () => {
  test("rejects non-positive maxTtsChars instead of hanging", () => {
    const h = harness();
    const cfg = { transport: h.transport, stt: h.stt, tts: h.tts };
    expect(() => createVoiceChannel({ ...cfg, maxTtsChars: 0 })).toThrow();
    expect(() => createVoiceChannel({ ...cfg, maxTtsChars: -5 })).toThrow();
    expect(() => createVoiceChannel({ ...cfg, maxTtsChars: Number.NaN })).toThrow();
    expect(() => createVoiceChannel({ ...cfg, maxTtsChars: Number.POSITIVE_INFINITY })).toThrow();
  });
});

describe("createVoiceChannel", () => {
  test("declares text+audio capabilities", () => {
    const h = harness();
    const ch = createVoiceChannel({ transport: h.transport, stt: h.stt, tts: h.tts });
    expect(ch.capabilities.text).toBe(true);
    expect(ch.capabilities.audio).toBe(true);
    expect(ch.capabilities.images).toBe(false);
  });

  test("name is 'voice'", () => {
    const h = harness();
    const ch = createVoiceChannel({ transport: h.transport, stt: h.stt, tts: h.tts });
    expect(ch.name).toBe("voice");
  });

  test("connect/disconnect proxy to transport", async () => {
    const h = harness();
    const ch = createVoiceChannel({ transport: h.transport, stt: h.stt, tts: h.tts });
    await ch.connect();
    await ch.disconnect();
    expect(h.connectCount).toBe(1);
    expect(h.disconnectCount).toBe(1);
  });

  test("inbound: audio frame → STT → InboundMessage with TextBlock", async () => {
    const h = harness({ sttResult: () => "hello world" });
    const ch = createVoiceChannel({ transport: h.transport, stt: h.stt, tts: h.tts });
    const received: InboundMessage[] = [];
    ch.onMessage(async (msg) => {
      received.push(msg);
    });
    await ch.connect();
    h.emitAudio(new Uint8Array([1, 2, 3]));
    await new Promise((r) => setTimeout(r, 5));
    expect(received).toHaveLength(1);
    const block = received[0]?.content[0] as TextBlock | undefined;
    expect(block?.kind).toBe("text");
    expect(block?.text).toBe("hello world");
    expect(received[0]?.senderId).toBe("voice-user");
    await ch.disconnect();
  });

  test("inbound: STT returns empty/whitespace → no message dispatched (silence)", async () => {
    // Regression: prior version dispatched empty TextBlock for "" or "   ",
    // burning a model turn on silence. normalize() now trims and treats
    // empty-after-trim as silence.
    for (const blank of ["", "   ", "\n\n  \t"]) {
      const h = harness({ sttResult: () => blank });
      const ch = createVoiceChannel({ transport: h.transport, stt: h.stt, tts: h.tts });
      const received: InboundMessage[] = [];
      ch.onMessage(async (msg) => {
        received.push(msg);
      });
      await ch.connect();
      h.emitAudio(new Uint8Array([1]));
      await new Promise((r) => setTimeout(r, 5));
      expect(received).toHaveLength(0);
      await ch.disconnect();
    }
  });

  test("inbound: STT returns null → no message dispatched", async () => {
    const h = harness({ sttResult: () => null });
    const ch = createVoiceChannel({ transport: h.transport, stt: h.stt, tts: h.tts });
    const received: InboundMessage[] = [];
    ch.onMessage(async (msg) => {
      received.push(msg);
    });
    await ch.connect();
    h.emitAudio(new Uint8Array([1]));
    await new Promise((r) => setTimeout(r, 5));
    expect(received).toHaveLength(0);
    await ch.disconnect();
  });

  test("outbound: TextBlock → TTS → transport.sendAudio", async () => {
    const h = harness();
    const ch = createVoiceChannel({ transport: h.transport, stt: h.stt, tts: h.tts });
    await ch.connect();
    await ch.send({ threadId: "session-1", content: [{ kind: "text", text: "reply" }] });
    expect(h.ttsCalls).toEqual(["reply"]);
    expect(h.sentAudio).toHaveLength(1);
    await ch.disconnect();
  });

  test("outbound: long text splits into multiple TTS chunks", async () => {
    const h = harness();
    const ch = createVoiceChannel({
      transport: h.transport,
      stt: h.stt,
      tts: h.tts,
      maxTtsChars: 5,
    });
    await ch.connect();
    await ch.send({ threadId: "session-1", content: [{ kind: "text", text: "abcdefghij" }] });
    expect(h.ttsCalls).toEqual(["abcde", "fghij"]);
    expect(h.sentAudio).toHaveLength(2);
    await ch.disconnect();
  });

  test("outbound: non-text blocks degrade to text via channel-base renderBlocks", async () => {
    // renderBlocks (in @koi/channel-base) converts non-text blocks to text
    // representations before platformSend. Voice TTS-es each text block in order.
    const h = harness();
    const ch = createVoiceChannel({ transport: h.transport, stt: h.stt, tts: h.tts });
    await ch.connect();
    await ch.send({
      threadId: "session-1",
      content: [
        { kind: "image", url: "x", alt: "diagram" },
        { kind: "text", text: "ok" },
      ],
    });
    expect(h.ttsCalls.length).toBeGreaterThanOrEqual(1);
    expect(h.ttsCalls.some((t) => t.includes("ok"))).toBe(true);
    await ch.disconnect();
  });

  test("outbound: custom blocks downgraded to spoken placeholder (no silent drop)", async () => {
    const h = harness();
    const ch = createVoiceChannel({ transport: h.transport, stt: h.stt, tts: h.tts });
    await ch.connect();
    await ch.send({
      threadId: "session-1",
      content: [
        { kind: "custom", type: "chart", data: {} },
        { kind: "text", text: "and the chart" },
      ],
    });
    expect(h.ttsCalls).toContain("[custom chart]");
    expect(h.ttsCalls).toContain("and the chart");
    await ch.disconnect();
  });

  test("STT failures surface via onSttError callback (not silently dropped)", async () => {
    const sttErr = new Error("transcribe failed");
    const h = harness();
    const errors: unknown[] = [];
    const failingStt: Stt = {
      transcribe: async () => {
        throw sttErr;
      },
    };
    const ch = createVoiceChannel({
      transport: h.transport,
      stt: failingStt,
      tts: h.tts,
      onSttError: (e) => {
        errors.push(e);
      },
    });
    const received: InboundMessage[] = [];
    ch.onMessage(async (m) => {
      received.push(m);
    });
    await ch.connect();
    h.emitAudio(new Uint8Array([1]));
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toHaveLength(0);
    expect(errors).toEqual([sttErr]);
    await ch.disconnect();
  });

  test("outbound: TTS failure on a later chunk emits NO audio (idempotent retry possible)", async () => {
    // Regression: prior version called sendAudio inside the synth loop, so a
    // TTS failure on chunk N left chunks 0..N-1 already spoken with no
    // idempotent retry path. Two-phase delivery: synth all chunks first, then
    // stream. A TTS failure means the user has heard nothing yet.
    const h = harness();
    let synthCount = 0;
    const flakyTts: Tts = {
      synthesize: async (text: string) => {
        synthCount++;
        if (synthCount === 2) throw new Error("tts down");
        return new Uint8Array([text.length]);
      },
    };
    const ch = createVoiceChannel({
      transport: h.transport,
      stt: h.stt,
      tts: flakyTts,
      maxTtsChars: 5,
    });
    await ch.connect();
    await expect(
      ch.send({ threadId: "session-1", content: [{ kind: "text", text: "abcdefghij" }] }),
    ).rejects.toThrow("tts down");
    expect(h.sentAudio).toEqual([]);
    await ch.disconnect();
  });

  test("STT failures are observable WITHOUT host wiring (default console.warn)", async () => {
    // Regression: prior version silently dropped STT failures unless the
    // host wired onSttError. A voice channel that black-holes speech errors
    // is a production recovery problem. Default-on logger fixes that.
    const sttErr = new Error("transcribe failed (default-logger test)");
    const h = harness();
    const failingStt: Stt = {
      transcribe: async () => {
        throw sttErr;
      },
    };
    const ch = createVoiceChannel({
      transport: h.transport,
      stt: failingStt,
      tts: h.tts,
      // NOTE: no onSttError — proves default-on behavior.
    });
    const received: InboundMessage[] = [];
    ch.onMessage(async (m) => {
      received.push(m);
    });
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      await ch.connect();
      h.emitAudio(new Uint8Array([1, 2, 3]));
      await new Promise((r) => setTimeout(r, 10));
      expect(received).toHaveLength(0);
      expect(warnings.length).toBeGreaterThan(0);
      const flat = warnings.flat();
      expect(flat.some((w) => w === sttErr)).toBe(true);
      await ch.disconnect();
    } finally {
      console.warn = originalWarn;
    }
  });

  test("outbound: image/file/button block semantics preserved in spoken text", async () => {
    // Regression: prior version emitted generic placeholders like
    // [image: image] and [button: button], stripping alt text, file names,
    // and button labels — leaving the listener with unintelligible audio
    // for any rich reply.
    const h = harness();
    const ch = createVoiceChannel({ transport: h.transport, stt: h.stt, tts: h.tts });
    await ch.connect();
    await ch.send({
      threadId: "session-1",
      content: [
        { kind: "image", url: "https://x/y.png", alt: "the diagram" },
        { kind: "image", url: "https://x/no-alt.png" },
        { kind: "file", url: "https://x/r.pdf", mimeType: "application/pdf", name: "report.pdf" },
        { kind: "file", url: "https://x/u.bin", mimeType: "application/octet-stream" },
        { kind: "button", label: "Open ticket", action: "open" },
      ],
    });
    expect(h.ttsCalls).toContain("Image: the diagram");
    expect(h.ttsCalls).toContain("Image at https://x/no-alt.png");
    expect(h.ttsCalls).toContain("File report.pdf (application/pdf) at https://x/r.pdf");
    expect(h.ttsCalls).toContain("File (application/octet-stream) at https://x/u.bin");
    expect(h.ttsCalls).toContain("Button: Open ticket");
    await ch.disconnect();
  });

  test("threads:true — inbound carries transport sessionId as threadId for multi-session isolation", async () => {
    const h = harness();
    const ch = createVoiceChannel({ transport: h.transport, stt: h.stt, tts: h.tts });
    expect(ch.capabilities.threads).toBe(true);
    const received: InboundMessage[] = [];
    ch.onMessage(async (m) => {
      received.push(m);
    });
    await ch.connect();
    h.emitAudio(new Uint8Array([1]), "call-A");
    h.emitAudio(new Uint8Array([2]), "call-B");
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toHaveLength(2);
    expect(received[0]?.threadId).toBe("call-A");
    expect(received[1]?.threadId).toBe("call-B");
    await ch.disconnect();
  });

  test("outbound: send without threadId throws (cross-talk guard)", async () => {
    const h = harness();
    const ch = createVoiceChannel({ transport: h.transport, stt: h.stt, tts: h.tts });
    await ch.connect();
    await expect(ch.send({ content: [{ kind: "text", text: "x" }] })).rejects.toThrow(
      /threadId is required/,
    );
    await expect(ch.send({ threadId: "", content: [{ kind: "text", text: "x" }] })).rejects.toThrow(
      /threadId is required/,
    );
    expect(h.sentUtterances).toEqual([]);
    await ch.disconnect();
  });

  test("outbound: transport receives whole utterance atomically with sessionId", async () => {
    const h = harness();
    const ch = createVoiceChannel({
      transport: h.transport,
      stt: h.stt,
      tts: h.tts,
      maxTtsChars: 5,
    });
    await ch.connect();
    await ch.send({ threadId: "call-X", content: [{ kind: "text", text: "abcdefghij" }] });
    expect(h.sentUtterances).toHaveLength(1);
    expect(h.sentUtterances[0]?.sessionId).toBe("call-X");
    expect(h.sentUtterances[0]?.frames).toHaveLength(2);
    await ch.disconnect();
  });

  test("custom senderId honored", async () => {
    const h = harness();
    const ch = createVoiceChannel({
      transport: h.transport,
      stt: h.stt,
      tts: h.tts,
      senderId: "caller-42",
    });
    const received: InboundMessage[] = [];
    ch.onMessage(async (msg) => {
      received.push(msg);
    });
    await ch.connect();
    h.emitAudio(new Uint8Array([1]));
    await new Promise((r) => setTimeout(r, 5));
    expect(received[0]?.senderId).toBe("caller-42");
    await ch.disconnect();
  });
});
