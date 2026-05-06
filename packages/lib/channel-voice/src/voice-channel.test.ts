import { describe, expect, test } from "bun:test";
import type { InboundMessage, TextBlock } from "@koi/core";
import {
  createVoiceChannel,
  type Stt,
  type Tts,
  VoiceSttTimeoutError,
  type VoiceTransport,
} from "./voice-channel.js";

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

  test("inbound: blank sessionId surfaces via onSttError (no one-way conversations)", async () => {
    // Regression: prior version accepted "" / whitespace sessionId at
    // ingress and only failed when replying with VoiceMissingSessionError,
    // turning a transport bug into a one-way conversation.
    const errors: unknown[] = [];
    const h = harness();
    const ch = createVoiceChannel({
      transport: h.transport,
      stt: h.stt,
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
    h.emitAudio(new Uint8Array([1]), "");
    h.emitAudio(new Uint8Array([2]), "   ");
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toEqual([]);
    expect(errors.length).toBe(2);
    expect(String(errors[0])).toMatch(/empty sessionId/);
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

  test("serializes STT per sessionId so a slow turn cannot be overtaken by a faster later turn", async () => {
    // Regression: without per-session STT chaining, utterance B (fast STT)
    // resolves before utterance A (slow STT) and dispatches first, scrambling
    // the dialogue order. Chaining ensures A is dispatched before B's STT
    // even starts on the same sessionId. Distinct sessionIds remain parallel.
    // let requires justification: harness state captured by callbacks
    let listener: ((sessionId: string, frame: Uint8Array) => void) | undefined;
    const sttOrder: string[] = [];
    const dispatchOrder: string[] = [];
    const transport: VoiceTransport = {
      connect: async () => {},
      disconnect: async () => {},
      sendUtterance: async () => {},
      onUtterance: (handler) => {
        listener = handler;
        return () => {
          listener = undefined;
        };
      },
    };
    const stt: Stt = {
      transcribe: async (audio) => {
        const tag = String(audio[0]);
        sttOrder.push(`start-${tag}`);
        // Frame [1]: slow (50 ms). Frame [2]: fast (5 ms). Without chaining,
        // [2] finishes first and dispatches before [1].
        const delay = audio[0] === 1 ? 50 : 5;
        await new Promise((r) => setTimeout(r, delay));
        sttOrder.push(`done-${tag}`);
        return `t${tag}`;
      },
    };
    const tts: Tts = { synthesize: async () => new Uint8Array() };
    const ch = createVoiceChannel({ transport, stt, tts });
    ch.onMessage(async (msg) => {
      const block = msg.content[0];
      if (block && block.kind === "text") dispatchOrder.push(block.text);
    });
    await ch.connect();
    // Two utterances back-to-back on the SAME session.
    listener?.("call-A", new Uint8Array([1]));
    listener?.("call-A", new Uint8Array([2]));
    await new Promise((r) => setTimeout(r, 120));
    // In-order dispatch despite [2] finishing STT 10x faster than [1].
    expect(dispatchOrder).toEqual(["t1", "t2"]);
    // Per-session chain enforced: [2]'s STT does not start until [1] is done.
    const doneA1 = sttOrder.indexOf("done-1");
    const startA2 = sttOrder.indexOf("start-2");
    expect(doneA1).toBeGreaterThanOrEqual(0);
    expect(startA2).toBeGreaterThan(doneA1);
    await ch.disconnect();
  });

  test("hung STT call times out so the per-session chain does not deadlock all later utterances", async () => {
    // Regression: per-session STT chaining (added round 3) made one stuck
    // stt.transcribe() block every later utterance for that sessionId
    // forever — a transient provider hang turning into a persistent one-
    // way voice outage. Now a bounded sttTimeoutMs causes the chain to
    // advance, the offender to surface via onSttError, and subsequent
    // turns to dispatch.
    // let requires justification: harness state captured by callbacks
    let listener: ((sessionId: string, frame: Uint8Array) => void) | undefined;
    const transport: VoiceTransport = {
      connect: async () => {},
      disconnect: async () => {},
      sendUtterance: async () => {},
      onUtterance: (handler) => {
        listener = handler;
        return () => {
          listener = undefined;
        };
      },
    };
    const stt: Stt = {
      transcribe: async (audio) => {
        // First frame: never resolves. Later frames: fast.
        if (audio[0] === 99) await new Promise(() => {});
        return `t${String(audio[0])}`;
      },
    };
    const tts: Tts = { synthesize: async () => new Uint8Array() };
    const sttErrors: unknown[] = [];
    const ch = createVoiceChannel({
      transport,
      stt,
      tts,
      sttTimeoutMs: 30,
      onSttError: (err) => sttErrors.push(err),
    });
    const dispatched: string[] = [];
    ch.onMessage(async (msg) => {
      const block = msg.content[0];
      if (block && block.kind === "text") dispatched.push(block.text);
    });
    await ch.connect();
    listener?.("call-A", new Uint8Array([99]));
    listener?.("call-A", new Uint8Array([1]));
    await new Promise((r) => setTimeout(r, 100));
    expect(sttErrors).toHaveLength(1);
    expect(sttErrors[0]).toBeInstanceOf(VoiceSttTimeoutError);
    expect(dispatched).toEqual(["t1"]);
    await ch.disconnect();
  });

  test("does not serialize across distinct sessionIds (per-session chain only)", async () => {
    // Independent calls must not head-of-line block each other's STT.
    // let requires justification: harness state captured by callbacks
    let listener: ((sessionId: string, frame: Uint8Array) => void) | undefined;
    let sttInFlight = 0;
    let sttMaxConcurrent = 0;
    const transport: VoiceTransport = {
      connect: async () => {},
      disconnect: async () => {},
      sendUtterance: async () => {},
      onUtterance: (handler) => {
        listener = handler;
        return () => {
          listener = undefined;
        };
      },
    };
    const stt: Stt = {
      transcribe: async () => {
        sttInFlight++;
        if (sttInFlight > sttMaxConcurrent) sttMaxConcurrent = sttInFlight;
        await new Promise((r) => setTimeout(r, 30));
        sttInFlight--;
        return "ok";
      },
    };
    const tts: Tts = { synthesize: async () => new Uint8Array() };
    const ch = createVoiceChannel({ transport, stt, tts });
    ch.onMessage(async () => {});
    await ch.connect();
    listener?.("call-A", new Uint8Array([1]));
    listener?.("call-B", new Uint8Array([1]));
    listener?.("call-C", new Uint8Array([1]));
    await new Promise((r) => setTimeout(r, 60));
    expect(sttMaxConcurrent).toBe(3);
    await ch.disconnect();
  });
});
