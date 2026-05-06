import { describe, expect, test } from "bun:test";
import type { InboundMessage, TextBlock } from "@koi/core";
import {
  createVoiceChannel,
  type Stt,
  type Tts,
  VoicePoisonedSessionError,
  VoiceSttTimeoutError,
  type VoiceTransport,
} from "./voice-channel.js";

interface SentUtterance {
  readonly sessionId: string;
  readonly utteranceId: string;
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
  readonly sendUtterance?: (
    sessionId: string,
    utteranceId: string,
    frames: readonly Uint8Array[],
  ) => Promise<void>;
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
      sendUtterance: async (sessionId, utteranceId, frames) => {
        if (opts?.sendUtterance) {
          await opts.sendUtterance(sessionId, utteranceId, frames);
        }
        sentUtterances.push({ sessionId, utteranceId, frames });
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

  test("startup race: utterance emitted synchronously during transport.connect() is NOT lost", async () => {
    // Regression: previously the voice adapter only subscribed to
    // transport.onUtterance after awaiting transport.connect(), so a
    // caller who spoke during the connect handshake (queued audio that
    // a transport drains on pipe-open) lost their first turn. The
    // transport listener is now registered BEFORE connect so racing
    // utterances buffer into the bounded pre-handler queue.
    // let requires justification: captured by transport callback
    let listener: ((sessionId: string, frame: Uint8Array) => void) | undefined;
    const racyTransport: VoiceTransport = {
      connect: async () => {
        listener?.("call-A", new Uint8Array([42]));
      },
      disconnect: async () => {},
      sendUtterance: async () => {},
      onUtterance: (handler) => {
        listener = handler;
        return () => {
          listener = undefined;
        };
      },
    };
    const stt: Stt = { transcribe: async () => "racing-first" };
    const tts: Tts = { synthesize: async () => new Uint8Array() };
    const ch = createVoiceChannel({ transport: racyTransport, stt, tts });
    const received: InboundMessage[] = [];
    ch.onMessage(async (msg) => {
      received.push(msg);
    });
    await ch.connect();
    await new Promise((r) => setTimeout(r, 30));
    expect(received).toHaveLength(1);
    const block = received[0]?.content[0] as TextBlock | undefined;
    expect(block?.text).toBe("racing-first");
    await ch.disconnect();
  });

  test("each send generates a unique utteranceId for transport-level dedup", async () => {
    // Round-10 high finding: VoiceTransport.sendUtterance now takes a
    // utteranceId so transports can implement idempotent dedup. Verify
    // distinct sends get distinct ids and a single send chunked into
    // multiple TTS pieces still uses ONE id (the dedup key is per
    // channel-level send, not per chunk).
    const h = harness();
    const ch = createVoiceChannel({
      transport: h.transport,
      stt: h.stt,
      tts: h.tts,
      maxTtsChars: 5,
    });
    await ch.connect();
    await ch.send({ threadId: "session-1", content: [{ kind: "text", text: "abcdefghij" }] });
    await ch.send({ threadId: "session-1", content: [{ kind: "text", text: "second" }] });
    expect(h.sentUtterances).toHaveLength(2);
    const id1 = h.sentUtterances[0]?.utteranceId;
    const id2 = h.sentUtterances[1]?.utteranceId;
    expect(typeof id1).toBe("string");
    expect(typeof id2).toBe("string");
    expect(id1).not.toBe(id2);
    expect(id1?.length).toBeGreaterThanOrEqual(16);
    await ch.disconnect();
  });

  test("caller-supplied metadata.utteranceId is preserved across retries for transport dedup", async () => {
    // Round-11 high finding: a freshly-minted random utteranceId on every
    // wrappedSend() defeats the dedup contract — a host or middleware retry
    // would key under a new id and the transport would play the utterance
    // twice. The contract: callers that retry MUST pass a stable id via
    // `message.metadata.utteranceId`, and the adapter MUST honor it.
    const h = harness();
    const ch = createVoiceChannel({ transport: h.transport, stt: h.stt, tts: h.tts });
    await ch.connect();
    const stableId = "stable-utterance-abc123";
    await ch.send({
      threadId: "session-1",
      content: [{ kind: "text", text: "first attempt" }],
      metadata: { utteranceId: stableId },
    });
    await ch.send({
      threadId: "session-1",
      content: [{ kind: "text", text: "retry of same logical outbound" }],
      metadata: { utteranceId: stableId },
    });
    expect(h.sentUtterances).toHaveLength(2);
    expect(h.sentUtterances[0]?.utteranceId).toBe(stableId);
    expect(h.sentUtterances[1]?.utteranceId).toBe(stableId);
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

  test("one stuck TTS does not block another session's reply (per-threadId outbound)", async () => {
    // Regression: round-5 channel-base globally serialized send(), so a
    // wedged tts.synthesize() for call-A blocked call-B's reply behind
    // the same chain. The voice wrapper now keeps a per-threadId chain
    // and bypasses inner.send entirely so distinct sessions are
    // concurrent on the outbound side.
    const sentForA: number[] = [];
    const sentForB: number[] = [];
    let resolveAFirst: (() => void) | undefined;
    const aGate = new Promise<void>((r) => {
      resolveAFirst = r;
    });
    const transport: VoiceTransport = {
      connect: async () => {},
      disconnect: async () => {},
      sendUtterance: async (sessionId, _utteranceId, frames) => {
        if (sessionId === "call-A") sentForA.push(frames.length);
        else sentForB.push(frames.length);
      },
      onUtterance: () => () => {},
    };
    const tts: Tts = {
      synthesize: async (text) => {
        if (text === "stuck") {
          await aGate;
          return new Uint8Array([1]);
        }
        return new Uint8Array([text.length]);
      },
    };
    const stt: Stt = { transcribe: async () => null };
    const ch = createVoiceChannel({ transport, stt, tts, transportSendTimeoutMs: 5000 });
    await ch.connect();
    // Fire A first — its TTS hangs on aGate. B fires immediately after.
    const aPromise = ch.send({ threadId: "call-A", content: [{ kind: "text", text: "stuck" }] });
    const bPromise = ch.send({ threadId: "call-B", content: [{ kind: "text", text: "fast" }] });
    // B should complete despite A being blocked.
    await bPromise;
    expect(sentForB).toHaveLength(1);
    expect(sentForA).toHaveLength(0);
    resolveAFirst?.();
    await aPromise;
    expect(sentForA).toHaveLength(1);
    await ch.disconnect();
  });

  test("TTS timeout rejects send (host can retry idempotently)", async () => {
    // Regression: without ttsTimeoutMs, a stuck tts.synthesize() would
    // hang the per-session chain forever even though the global queue is
    // gone. The bounded timeout surfaces VoiceTtsTimeoutError so the
    // session chain advances on the next send and the host knows to retry.
    const transport: VoiceTransport = {
      connect: async () => {},
      disconnect: async () => {},
      sendUtterance: async () => {},
      onUtterance: () => () => {},
    };
    const tts: Tts = { synthesize: () => new Promise(() => {}) };
    const stt: Stt = { transcribe: async () => null };
    const ch = createVoiceChannel({ transport, stt, tts, ttsTimeoutMs: 30 });
    await ch.connect();
    await expect(
      ch.send({ threadId: "session-1", content: [{ kind: "text", text: "x" }] }),
    ).rejects.toThrow(/TTS synthesize exceeded/);
    await ch.disconnect();
  });

  test("transport timeout poisons session — stale send cannot reorder with later sends", async () => {
    // Round-12 high finding: transport.sendUtterance() timing out only
    // races the timer; the underlying call keeps running. If we accepted
    // a newer send on the same session, the stale resolve would fire
    // AFTER the new audio (broken ordering) or alongside a retry
    // (overlap). Fix: poison the session on timeout so subsequent sends
    // fail-fast with VoicePoisonedSessionError until disconnect.
    // let requires justification: harness state captured by transport closure
    let resolveStuck: (() => void) | undefined;
    const sentOrder: string[] = [];
    const transport: VoiceTransport = {
      connect: async () => {},
      disconnect: async () => {},
      sendUtterance: async (sessionId, utteranceId) => {
        if (utteranceId === "stuck") {
          await new Promise<void>((r) => {
            resolveStuck = r;
          });
        }
        sentOrder.push(utteranceId);
      },
      onUtterance: () => () => {},
    };
    const stt: Stt = { transcribe: async () => null };
    const tts: Tts = { synthesize: async () => new Uint8Array(0) };
    const ch = createVoiceChannel({ transport, stt, tts, transportSendTimeoutMs: 30 });
    await ch.connect();
    // First send hits the stuck path → times out → poisons session.
    await expect(
      ch.send({
        threadId: "session-1",
        content: [{ kind: "text", text: "first" }],
        metadata: { utteranceId: "stuck" },
      }),
    ).rejects.toThrow(/transport.sendUtterance exceeded/);
    // Newer send on the same session must reject immediately, not queue
    // behind / interleave with the still-in-flight stale call.
    await expect(
      ch.send({
        threadId: "session-1",
        content: [{ kind: "text", text: "second" }],
        metadata: { utteranceId: "newer" },
      }),
    ).rejects.toBeInstanceOf(VoicePoisonedSessionError);
    // Distinct session is unaffected by another session's poison.
    await ch.send({
      threadId: "session-2",
      content: [{ kind: "text", text: "other" }],
      metadata: { utteranceId: "other" },
    });
    expect(sentOrder).toEqual(["other"]);
    // Now release the stale call; it must NOT have produced any audio
    // for "newer", and the only completion on session-1 is the stale one.
    resolveStuck?.();
    await new Promise((r) => setTimeout(r, 20));
    expect(sentOrder).toEqual(["other", "stuck"]);
    // Round-15: disconnect aborts every in-flight controller (cooperative
    // transports reject promptly), then clears poison. Stable-session
    // transports (single-call adapters using a constant threadId) recover
    // cleanly on reconnect. The transport in this test is non-cooperative
    // (ignores signal), so we manually release after disconnect.
    await ch.disconnect();
    resolveStuck = undefined;
    await ch.connect();
    await ch.send({
      threadId: "session-1",
      content: [{ kind: "text", text: "after-recovery" }],
      metadata: { utteranceId: "after-recovery" },
    });
    expect(sentOrder).toContain("after-recovery");
    await ch.disconnect();
  });

  test("AbortSignal is forwarded to TTS and transport on timeout (cooperative cancellation)", async () => {
    // Round-14 high finding: withTimeout only races; underlying calls
    // could leak after the channel reports failure. Cooperative impls
    // get an AbortSignal and SHOULD reject promptly so the channel can
    // fence the call. Verify the signal is plumbed and aborts on timeout.
    let ttsSignal: AbortSignal | undefined;
    let sendSignal: AbortSignal | undefined;
    let ttsAborted = false;
    let sendAborted = false;
    const tts: Tts = {
      synthesize: (_text, signal) => {
        ttsSignal = signal;
        return new Promise<Uint8Array>((_, reject) => {
          signal?.addEventListener("abort", () => {
            ttsAborted = true;
            reject(new Error("aborted"));
          });
        });
      },
    };
    const transport: VoiceTransport = {
      connect: async () => {},
      disconnect: async () => {},
      sendUtterance: (_s, _u, _f, signal) => {
        sendSignal = signal;
        return new Promise<void>((_, reject) => {
          signal?.addEventListener("abort", () => {
            sendAborted = true;
            reject(new Error("aborted"));
          });
        });
      },
      onUtterance: () => () => {},
    };
    const stt: Stt = { transcribe: async () => null };
    const ch = createVoiceChannel({ transport, stt, tts, ttsTimeoutMs: 30 });
    await ch.connect();
    await expect(
      ch.send({ threadId: "tts-abort", content: [{ kind: "text", text: "hello" }] }),
    ).rejects.toThrow(/TTS synthesize exceeded/);
    expect(ttsSignal).toBeDefined();
    expect(ttsAborted).toBe(true);
    // Transport never reached because TTS aborted first.
    expect(sendSignal).toBeUndefined();
    await ch.disconnect();

    // Now the transport-timeout path on a fresh adapter (poison persists
    // per-adapter, so we use a new instance to test transport abort).
    const ch2 = createVoiceChannel({
      transport,
      stt,
      tts: { synthesize: async () => new Uint8Array(0) },
      transportSendTimeoutMs: 30,
    });
    await ch2.connect();
    await expect(
      ch2.send({ threadId: "send-abort", content: [{ kind: "text", text: "hi" }] }),
    ).rejects.toThrow(/transport.sendUtterance exceeded/);
    expect(sendSignal).toBeDefined();
    expect(sendAborted).toBe(true);
    await ch2.disconnect();
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
