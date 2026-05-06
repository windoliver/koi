import { describe, expect, test } from "bun:test";
import type { InboundMessage, TextBlock } from "@koi/core";
import {
  createVoiceChannel,
  replyToVoiceInbound,
  type Stt,
  type Tts,
  VOICE_CALL_EPOCH_KEY,
  VoicePoisonedSessionError,
  VoiceSttTimeoutError,
  type VoiceTransport,
  VoiceTransportSendTimeoutError,
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
      onUtterance: (handler: (sessionId: string, frame: Uint8Array) => void) => {
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
    ch.onMessage(async (msg: InboundMessage) => {
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
    // Round-37 high: the timeout error must carry the effective
    // utteranceId AND sessionId so retry middleware has a stable
    // dedupe key (transport.sendUtterance idempotency depends on it).
    let captured: VoiceTransportSendTimeoutError | undefined;
    try {
      await ch.send({
        threadId: "session-1",
        content: [{ kind: "text", text: "first" }],
        metadata: { utteranceId: "stuck" },
      });
    } catch (e) {
      if (e instanceof VoiceTransportSendTimeoutError) captured = e;
    }
    expect(captured).toBeInstanceOf(VoiceTransportSendTimeoutError);
    expect(captured?.utteranceId).toBe("stuck");
    expect(captured?.sessionId).toBe("session-1");
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
    // Round-33 contract: once disconnect's bounded fence has positively
    // confirmed all stale raw ops settled (cooperative transport that
    // honored the abort, OR a stuck call that completed before
    // disconnect ran), the poison clears so reused threadIds recover.
    // The non-cooperative-transport case is covered by the next test.
    await ch.disconnect();
    resolveStuck = undefined;
    await ch.connect();
    // Round-38 contract: post-reconnect bare sends require the per-call
    // epoch tag — the adapter has disconnected at least once, so any
    // detached send (no ALS context, no metadata.voiceCallEpoch) would
    // be rejected as a stale-leak guard. Stamping the current epoch
    // (1 after first disconnect) demonstrates the explicit recovery
    // path.
    await ch.send({
      threadId: "session-1",
      content: [{ kind: "text", text: "recovered" }],
      metadata: { utteranceId: "recovered", voiceCallEpoch: 1 },
    });
    expect(sentOrder).toContain("recovered");
    await ch.disconnect();
  });

  test("non-cooperative transport keeps poison across reconnect (fence cannot prove safety)", async () => {
    // Regression (round 33 high counterpart): clean-fence recovery only
    // applies when raw ops actually settled. A transport that ignores
    // the abort signal leaves the inflight raw op pending past the
    // disconnect fence — its stale audio could still surface later, so
    // the poison MUST persist for the adapter's lifetime to prevent
    // reorder/overlap into a fresh call on the same reused threadId.
    let stuckPromise: Promise<void> | undefined;
    const sentOrder: string[] = [];
    const transport: VoiceTransport = {
      connect: async () => {},
      disconnect: async () => {},
      sendUtterance: async (_s, utteranceId) => {
        if (utteranceId === "stuck") {
          // Never resolves and ignores any abort signal: a non-
          // cooperative transport.
          stuckPromise = new Promise<void>(() => {});
          await stuckPromise;
        }
        sentOrder.push(utteranceId);
      },
      onUtterance: () => () => {},
    };
    const stt: Stt = { transcribe: async () => null };
    const tts: Tts = { synthesize: async () => new Uint8Array(0) };
    const ch = createVoiceChannel({ transport, stt, tts, transportSendTimeoutMs: 30 });
    await ch.connect();
    await expect(
      ch.send({
        threadId: "session-x",
        content: [{ kind: "text", text: "first" }],
        metadata: { utteranceId: "stuck" },
      }),
    ).rejects.toThrow(/transport.sendUtterance exceeded/);
    // Disconnect fence runs against the still-stuck raw op; it cannot
    // settle within DISCONNECT_FENCE_TIMEOUT_MS (2 s default — but the
    // test cannot afford to wait). We override that by NOT awaiting
    // disconnect's full fence; instead, we just verify post-reconnect
    // poison is preserved when the raw op is still inflight at clear
    // time. To keep the test fast we use a short disconnect fence
    // through internal knowledge: poison persists IFF inflightRawOps
    // is nonempty when the fence finishes.
    // Use a parallel send to keep the raw op tracked, then a quick
    // disconnect proves the persistence path. The 2 s wait is real
    // here (the fence must time out) — accept it as the cost of
    // verifying the safety contract.
    const disconnectStarted = Date.now();
    await ch.disconnect();
    const disconnectDuration = Date.now() - disconnectStarted;
    // Sanity: disconnect actually waited on the fence (gives ~2 s).
    expect(disconnectDuration).toBeGreaterThanOrEqual(1900);
    await ch.connect();
    await expect(
      ch.send({
        threadId: "session-x",
        content: [{ kind: "text", text: "still-poisoned" }],
        metadata: { utteranceId: "after-reconnect" },
      }),
    ).rejects.toBeInstanceOf(VoicePoisonedSessionError);
    await ch.disconnect();
  });

  test("same-session handler dispatches serialize across full pipeline (no overlap)", async () => {
    // Round-16 high finding: per-session STT chain only awaited
    // transcribe(), not the host's handler. Two utterances on the same
    // sessionId could overlap in the handler — concurrent model/tool
    // work mutating shared session state and replying out of order.
    // Fix: voice's wrapped onMessage records handler promises per
    // threadId; the STT chain awaits them before processing the next
    // utterance. Cross-session traffic stays parallel.
    // let requires justification: harness state captured by closures
    let listener: ((sessionId: string, frame: Uint8Array) => void) | undefined;
    let inFlightSameSession = 0;
    let maxInFlightSameSession = 0;
    let inFlightCrossSession = 0;
    let maxInFlightCrossSession = 0;
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
    const stt: Stt = { transcribe: async () => "ok" };
    const tts: Tts = { synthesize: async () => new Uint8Array(0) };
    const ch = createVoiceChannel({ transport, stt, tts });
    await ch.connect();
    ch.onMessage(async (msg: InboundMessage) => {
      // Slow handler simulating model+tool runtime work.
      if (msg.threadId === "session-A") {
        inFlightSameSession++;
        if (inFlightSameSession > maxInFlightSameSession) {
          maxInFlightSameSession = inFlightSameSession;
        }
        await new Promise((r) => setTimeout(r, 50));
        inFlightSameSession--;
      } else {
        inFlightCrossSession++;
        if (inFlightCrossSession > maxInFlightCrossSession) {
          maxInFlightCrossSession = inFlightCrossSession;
        }
        await new Promise((r) => setTimeout(r, 50));
        inFlightCrossSession--;
      }
    });
    // Fire 3 same-session + 1 cross-session utterances back-to-back.
    listener!("session-A", new Uint8Array([1]));
    listener!("session-A", new Uint8Array([2]));
    listener!("session-A", new Uint8Array([3]));
    listener!("session-B", new Uint8Array([4]));
    // Wait for the chain to fully settle.
    await new Promise((r) => setTimeout(r, 250));
    // Same-session handlers MUST NEVER overlap.
    expect(maxInFlightSameSession).toBe(1);
    // Cross-session can still run in parallel with same-session work.
    expect(maxInFlightCrossSession).toBe(1);
    await ch.disconnect();
  });

  test("after timeout+reconnect, same threadId stays poisoned but a fresh threadId works", async () => {
    // Round-20 high finding: a non-cooperative transport's stale op
    // can surface AFTER reconnect, so reused threadIds cannot be
    // safely re-admitted (overlap risk). Contract: poison persists
    // for the adapter's lifetime per threadId. Hosts using stable
    // threadIds (the documented `"default"` pattern) MUST construct
    // a fresh adapter to recover; hosts using unique threadIds per
    // call are unaffected — different threadId works on the same
    // adapter post-reconnect.
    // let requires justification: harness state captured by closures
    let resolveStuck: (() => void) | undefined;
    const sentOrder: string[] = [];
    const transport: VoiceTransport = {
      connect: async () => {},
      disconnect: async () => {},
      sendUtterance: async (_s, utteranceId) => {
        // First call hangs forever (ignores abort). Later calls run.
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
    const ch = createVoiceChannel({
      transport,
      stt,
      tts,
      transportSendTimeoutMs: 50,
    });
    await ch.connect();
    await expect(
      ch.send({
        threadId: "default",
        content: [{ kind: "text", text: "first" }],
        metadata: { utteranceId: "stuck" },
      }),
    ).rejects.toThrow(/transport.sendUtterance exceeded/);
    // Same threadId is poisoned within this generation.
    await expect(
      ch.send({
        threadId: "default",
        content: [{ kind: "text", text: "blocked" }],
        metadata: { utteranceId: "blocked" },
      }),
    ).rejects.toBeInstanceOf(VoicePoisonedSessionError);
    // Disconnect (raw op still hung; fence times out at 2 s).
    await ch.disconnect();
    // Reconnect — a fresh generation; poison entries persist.
    await ch.connect();
    // Reused threadId is STILL poisoned (overlap protection).
    await expect(
      ch.send({
        threadId: "default",
        content: [{ kind: "text", text: "still-blocked" }],
        metadata: { utteranceId: "still-blocked" },
      }),
    ).rejects.toBeInstanceOf(VoicePoisonedSessionError);
    // A fresh threadId works on the same adapter — but the post-
    // reconnect bare send must still carry the per-call epoch tag
    // (round-38 contract) since the adapter has disconnected once
    // (connectGen === 1).
    await ch.send({
      threadId: "fresh-thread",
      content: [{ kind: "text", text: "fresh" }],
      metadata: { utteranceId: "fresh", voiceCallEpoch: 1 },
    });
    expect(sentOrder).toContain("fresh");
    // Release the still-hung first call so the test process exits.
    resolveStuck?.();
    await ch.disconnect();
  });

  test("stale handler from old generation cannot send into reused threadId after reconnect", async () => {
    // Round-21 high finding: outbound serialization protected against
    // stale TTS/transport, but inbound handlers were not bound to the
    // connection generation. A host handler that paused (awaiting
    // model/tool work) across disconnect/reconnect could later call
    // ch.send() on a reused threadId — leaking a stale reply into
    // the new call. Fix: ALS pins connectGen at handler entry; any
    // wrappedSend() in the handler chain rejects when the captured
    // gen no longer matches.
    // let requires justification: harness state captured by closures
    let listener: ((sessionId: string, frame: Uint8Array) => void) | undefined;
    let releaseHandler: (() => void) | undefined;
    const sentOrder: string[] = [];
    const transport: VoiceTransport = {
      connect: async () => {},
      disconnect: async () => {},
      sendUtterance: async (_s, utteranceId) => {
        sentOrder.push(utteranceId);
      },
      onUtterance: (handler) => {
        listener = handler;
        return () => {
          listener = undefined;
        };
      },
    };
    const stt: Stt = { transcribe: async () => "transcript" };
    const tts: Tts = { synthesize: async () => new Uint8Array(0) };
    const ch = createVoiceChannel({ transport, stt, tts });
    await ch.connect();
    let handlerSendError: unknown;
    ch.onMessage(async (_msg: InboundMessage) => {
      // Pause the handler until the test releases it (after reconnect).
      await new Promise<void>((r) => {
        releaseHandler = r;
      });
      try {
        await ch.send({
          threadId: "default",
          content: [{ kind: "text", text: "stale reply" }],
          metadata: { utteranceId: "stale" },
        });
      } catch (e) {
        handlerSendError = e;
      }
    });
    listener!("default", new Uint8Array([1]));
    // Wait for the inbound to dispatch and the handler to start.
    await new Promise((r) => setTimeout(r, 30));
    // Now disconnect/reconnect — host handler is paused, in old gen.
    await ch.disconnect();
    await ch.connect();
    // Release the stale handler. Its ch.send() must reject.
    releaseHandler?.();
    await new Promise((r) => setTimeout(r, 30));
    expect(handlerSendError).toBeInstanceOf(VoicePoisonedSessionError);
    expect(sentOrder).not.toContain("stale");
    await ch.disconnect();
  });

  test("connect failure rolls back the pre-subscribed onUtterance listener", async () => {
    // Round-26 high finding: voice subscribes to transport.onUtterance
    // BEFORE awaiting transport.connect() to avoid the startup race.
    // Without rollback, a transient connect failure leaked the
    // listener; on retry each utterance would be transcribed and
    // dispatched once per leaked subscription — duplicate STT/TTS
    // work and duplicate spoken replies.
    let attemptsBeforeSuccess = 1;
    let liveListeners = 0;
    const transport: VoiceTransport = {
      connect: async () => {
        if (attemptsBeforeSuccess > 0) {
          attemptsBeforeSuccess--;
          throw new Error("transient connect failure");
        }
      },
      disconnect: async () => {},
      sendUtterance: async () => {},
      onUtterance: () => {
        liveListeners++;
        return () => {
          liveListeners--;
        };
      },
    };
    const stt: Stt = { transcribe: async () => null };
    const tts: Tts = { synthesize: async () => new Uint8Array(0) };
    const ch = createVoiceChannel({ transport, stt, tts });
    await expect(ch.connect()).rejects.toThrow(/transient/);
    expect(liveListeners).toBe(0);
    await ch.connect();
    expect(liveListeners).toBe(1);
    await ch.disconnect();
  });

  test("disconnect quiesces ingress immediately so no new utterances enter STT", async () => {
    // Round-24 high finding: disconnect deferred ingress teardown
    // until inner.disconnect ran AFTER the raw-op fence. During the
    // fence window (up to 2 s), transport.onUtterance could still
    // feed new audio into STT/dispatch — a host's onMessage handler
    // could be triggered for a turn the host believed was past the
    // shutdown boundary. Fix: clear rawUtteranceSink immediately at
    // start of disconnect so subsequent utterances are dropped.
    let listener: ((sessionId: string, frame: Uint8Array) => void) | undefined;
    let sttCalls = 0;
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
        sttCalls++;
        return "noop";
      },
    };
    const tts: Tts = { synthesize: async () => new Uint8Array(0) };
    const ch = createVoiceChannel({ transport, stt, tts });
    await ch.connect();
    // Begin disconnect — but don't await it yet, so we can race an
    // inbound utterance against the fence window.
    const disconnectPromise = ch.disconnect();
    // Fire utterance AFTER disconnect started but BEFORE it returned.
    listener?.("session-ingress", new Uint8Array([1]));
    await disconnectPromise;
    // STT MUST NOT have been called for the post-disconnect utterance.
    expect(sttCalls).toBe(0);
  });

  test("queued sends do not execute after disconnect (without reconnect)", async () => {
    // Round-23 high finding: previously connectGen only bumped on
    // connect, not disconnect. A queued op behind a hung first send
    // could later execute performSend AFTER disconnect completed —
    // synthesizing TTS and writing to a torn-down transport that the
    // host believed was drained. Fix: bump connectGen on disconnect
    // too, so queued ops detect the gen mismatch and reject.
    let resolveStuck: (() => void) | undefined;
    const sentOrder: string[] = [];
    const transport: VoiceTransport = {
      connect: async () => {},
      disconnect: async () => {},
      sendUtterance: async (_s, utteranceId) => {
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
    const ch = createVoiceChannel({ transport, stt, tts });
    await ch.connect();
    const stuckPromise = ch.send({
      threadId: "session-q2",
      content: [{ kind: "text", text: "first" }],
      metadata: { utteranceId: "stuck" },
    });
    const queuedPromise = ch.send({
      threadId: "session-q2",
      content: [{ kind: "text", text: "queued" }],
      metadata: { utteranceId: "queued-no-reconnect" },
    });
    await new Promise((r) => setTimeout(r, 30));
    // Disconnect WITHOUT reconnecting.
    await ch.disconnect();
    // Release the stuck call so prev settles and the queued op fires.
    resolveStuck?.();
    await new Promise((r) => setTimeout(r, 30));
    await expect(queuedPromise).rejects.toBeInstanceOf(VoicePoisonedSessionError);
    await stuckPromise;
    // Queued utterance MUST NOT have reached the (torn-down) transport.
    expect(sentOrder).not.toContain("queued-no-reconnect");
  });

  test("queued sends behind a hung send do not execute after disconnect/reconnect", async () => {
    // Round-20 high finding: wrappedSend chains queued ops as
    // `prev.catch().then(() => performSend(...))`. If prev hangs and
    // disconnect/reconnect happens before prev settles, the queued op
    // would later execute performSend in the new generation —
    // synthesizing TTS and sending audio for a turn the host thought
    // was drained. Fix: capture queuedGen at queue time; performSend
    // skips with VoicePoisonedSessionError if the gen no longer matches.
    // let requires justification: harness state captured by closures
    let resolveStuck: (() => void) | undefined;
    const sentOrder: string[] = [];
    const transport: VoiceTransport = {
      connect: async () => {},
      disconnect: async () => {},
      sendUtterance: async (_s, utteranceId) => {
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
    const ch = createVoiceChannel({ transport, stt, tts });
    await ch.connect();
    // First send hangs.
    const stuckPromise = ch.send({
      threadId: "session-q",
      content: [{ kind: "text", text: "first" }],
      metadata: { utteranceId: "stuck" },
    });
    // Second send queues behind it on the same session chain.
    const queuedPromise = ch.send({
      threadId: "session-q",
      content: [{ kind: "text", text: "queued" }],
      metadata: { utteranceId: "queued-after-disconnect" },
    });
    // Disconnect + reconnect while both are pending.
    await new Promise((r) => setTimeout(r, 30));
    await ch.disconnect();
    await ch.connect();
    // Release the stuck call so prev settles and the queued op runs.
    resolveStuck?.();
    // Queued op MUST be rejected with VoicePoisonedSessionError, not
    // execute performSend in the new generation.
    await expect(queuedPromise).rejects.toBeInstanceOf(VoicePoisonedSessionError);
    // Stuck completed (its underlying transport call ran in old gen).
    await stuckPromise;
    // Queued utterance MUST NOT have reached the transport.
    expect(sentOrder).not.toContain("queued-after-disconnect");
    await ch.disconnect();
  });

  test("disconnect with an abort-ignoring transport completes within the fence (no 30s hang)", async () => {
    // Round-18 high finding: disconnect awaited the timeout-wrapped
    // performSend chain, which doesn't settle until ttsTimeoutMs /
    // transportSendTimeoutMs if the impl ignores AbortSignal. A
    // non-cooperative provider would hold disconnect open for the
    // full 30s default — defeating the purpose of having a fence.
    // Fix: skip the chain wait, fence only on the raw ops with a
    // bounded 2 s timeout.
    const transport: VoiceTransport = {
      connect: async () => {},
      disconnect: async () => {},
      // Ignores signal entirely — never settles.
      sendUtterance: () => new Promise(() => {}),
      onUtterance: () => () => {},
    };
    const stt: Stt = { transcribe: async () => null };
    const tts: Tts = { synthesize: async () => new Uint8Array(0) };
    const ch = createVoiceChannel({
      transport,
      stt,
      tts,
      transportSendTimeoutMs: 30_000, // would dominate disconnect time
    });
    await ch.connect();
    // Fire and forget — we know it'll never settle.
    ch.send({ threadId: "ignored", content: [{ kind: "text", text: "x" }] }).catch(() => {});
    // Wait for the send to register its raw op.
    await new Promise((r) => setTimeout(r, 30));
    const start = Date.now();
    await ch.disconnect();
    const elapsed = Date.now() - start;
    // Bounded by DISCONNECT_FENCE_TIMEOUT_MS (2 s) plus small slack.
    expect(elapsed).toBeLessThan(3_000);
  });

  test("TTS-only timeout does not poison the threadId (audio never reached transport)", async () => {
    // Round-22 high finding refinement: TTS timeout fires BEFORE
    // transport.sendUtterance is called, so no audio is on the wire.
    // Persistently poisoning the threadId for what amounts to a
    // transient TTS provider hang permanently bricked stable
    // threadIds (`"default"` pattern). Now only transport timeouts
    // poison; TTS-only timeouts leave the threadId usable on retry.
    const transport: VoiceTransport = {
      connect: async () => {},
      disconnect: async () => {},
      sendUtterance: async () => {},
      onUtterance: () => () => {},
    };
    // First call hangs forever; subsequent calls succeed.
    let ttsCallCount = 0;
    const tts: Tts = {
      synthesize: async (_text, _signal) => {
        ttsCallCount++;
        if (ttsCallCount === 1) {
          await new Promise(() => {}); // hang
        }
        return new Uint8Array(0);
      },
    };
    const stt: Stt = { transcribe: async () => null };
    const ch = createVoiceChannel({ transport, stt, tts, ttsTimeoutMs: 30 });
    await ch.connect();
    await expect(
      ch.send({
        threadId: "stable",
        content: [{ kind: "text", text: "first" }],
        metadata: { utteranceId: "first" },
      }),
    ).rejects.toThrow(/TTS synthesize exceeded/);
    // Same threadId is NOT poisoned — TTS produced no audio, so the
    // channel can safely accept a retry. (Contrast with transport
    // timeouts, which DO persistently poison since bytes may already
    // be on the wire.)
    await ch.send({
      threadId: "stable",
      content: [{ kind: "text", text: "retry" }],
      metadata: { utteranceId: "retry" },
    });
    await ch.disconnect();
  });

  test("STT timeout aborts the underlying transcribe so abandoned work does not accumulate", async () => {
    // Round-22 medium finding: STT timeout used Promise.race only,
    // so a hung provider kept running per utterance — burning
    // quota/CPU and hiding the outage. Fix: pass AbortSignal to
    // stt.transcribe; abort on timeout.
    let listener: ((sessionId: string, frame: Uint8Array) => void) | undefined;
    let aborted = false;
    let signalSeen = false;
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
      transcribe: (_audio, signal) => {
        signalSeen = signal !== undefined;
        return new Promise<null>((_, reject) => {
          signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        });
      },
    };
    const tts: Tts = { synthesize: async () => new Uint8Array(0) };
    const ch = createVoiceChannel({
      transport,
      stt,
      tts,
      sttTimeoutMs: 30,
      onSttError: () => {},
    });
    await ch.connect();
    listener!("session-stt-abort", new Uint8Array([1]));
    await new Promise((r) => setTimeout(r, 80));
    expect(signalSeen).toBe(true);
    expect(aborted).toBe(true);
    await ch.disconnect();
  });

  test("disconnect aborts in-flight STT (no orphaned transcription burning provider quota)", async () => {
    // Regression (round 35 medium): STT controllers were tracked only
    // in the per-utterance enqueue closure; disconnect() aborted only
    // TTS/transport controllers. A disconnect/failover during STT left
    // the transcription request alive until its own provider timeout,
    // accumulating unrecoverable load on repeated reconnects.
    let listener: ((sessionId: string, audio: Uint8Array) => void) | undefined;
    let sttAborted = false;
    let sttSignalSeen = false;
    const transport: VoiceTransport = {
      connect: async () => {},
      disconnect: async () => {},
      sendUtterance: async () => {},
      onUtterance: (h) => {
        listener = h;
        return () => {
          listener = undefined;
        };
      },
    };
    const stt: Stt = {
      transcribe: (_audio, signal) => {
        sttSignalSeen = signal !== undefined;
        return new Promise<string>((_, reject) => {
          signal?.addEventListener("abort", () => {
            sttAborted = true;
            reject(new Error("aborted"));
          });
        });
      },
    };
    const tts: Tts = { synthesize: async () => new Uint8Array() };
    const ch = createVoiceChannel({
      transport,
      stt,
      tts,
      // Long STT timeout so disconnect — not the timeout — does the abort.
      sttTimeoutMs: 60_000,
    });
    ch.onMessage(async () => {});
    await ch.connect();
    listener?.("call-stt-disc", new Uint8Array([1]));
    // Let the STT request register its controller.
    await new Promise((r) => setTimeout(r, 30));
    expect(sttSignalSeen).toBe(true);
    await ch.disconnect();
    expect(sttAborted).toBe(true);
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

  test("detached send post-reconnect requires per-call epoch tag (cross-call leak fence)", async () => {
    // Regression (round 38 high): a handler that captures the inbound,
    // returns, and later resumes OUTSIDE the inbound's ALS scope (e.g.,
    // through queueMicrotask, setTimeout, or a third-party promise
    // wrapper) used to slip through the gen check because the ALS
    // store was empty. With a stable threadId pattern (`"default"`),
    // the stale reply could speak into a fresh post-reconnect call.
    // Fix: every inbound is stamped with metadata.voiceCallEpoch; the
    // adapter rejects any post-reconnect bare send that neither has
    // ALS context nor a matching epoch tag.
    let listener: ((sessionId: string, audio: Uint8Array) => void) | undefined;
    const sentBy: string[] = [];
    const transport: VoiceTransport = {
      connect: async () => {},
      disconnect: async () => {},
      sendUtterance: async (_s, _u, frames) => {
        for (const f of frames) sentBy.push(`[${f[0]}]`);
      },
      onUtterance: (h) => {
        listener = h;
        return () => {
          listener = undefined;
        };
      },
    };
    const stt: Stt = { transcribe: async () => "ok" };
    const tts: Tts = { synthesize: async (text) => new Uint8Array([text.charCodeAt(0)]) };
    const ch = createVoiceChannel({ transport, stt, tts });
    let captured: InboundMessage | undefined;
    ch.onMessage(async (msg) => {
      captured = msg;
    });
    await ch.connect();
    listener?.("default", new Uint8Array([1]));
    await new Promise((r) => setTimeout(r, 30));
    expect(captured).toBeDefined();
    // Inbound is stamped with the current epoch (0 on first connect).
    expect(captured?.metadata?.[VOICE_CALL_EPOCH_KEY]).toBe(0);
    // Disconnect + reconnect — the captured inbound is now stale.
    await ch.disconnect();
    await ch.connect();
    // A detached send carrying the OLD epoch (via replyToVoiceInbound)
    // must be rejected — old call done, do not speak into the new one
    // even on the reused threadId.
    const detachedReply = replyToVoiceInbound(captured as InboundMessage, {
      threadId: "default",
      content: [{ kind: "text", text: "stale" }],
    });
    await expect(ch.send(detachedReply)).rejects.toBeInstanceOf(VoicePoisonedSessionError);
    // A bare detached send (no ALS, no tag) is also rejected post-
    // reconnect — the cross-call leak guard.
    await expect(
      ch.send({
        threadId: "default",
        content: [{ kind: "text", text: "untagged" }],
      }),
    ).rejects.toBeInstanceOf(VoicePoisonedSessionError);
    expect(sentBy).toEqual([]); // nothing leaked into the new call.
    await ch.disconnect();
  });

  test("multi-handler turn: hung first handler is fenced even when later handlers settle", async () => {
    // Regression (round 34 high): per-handler turn tracking overwrote
    // the session-dispatch slot on every wrapped handler invocation,
    // so the watchdog only fenced the LAST registered handler. With
    // ≥2 async handlers (e.g. logging + business logic), an earlier
    // hung handler could resume past the watchdog and speak into a
    // newer turn. The per-turn collector aggregates ALL registered
    // handlers' promises so the watchdog fences the ENTIRE turn.
    let listener: ((sessionId: string, audio: Uint8Array) => void) | undefined;
    const sentBy: string[] = [];
    const transport: VoiceTransport = {
      connect: async () => {},
      disconnect: async () => {},
      sendUtterance: async (_s, _u, frames) => {
        for (const f of frames) sentBy.push(`[${f[0]}]`);
      },
      onUtterance: (h) => {
        listener = h;
        return () => {
          listener = undefined;
        };
      },
    };
    const stt: Stt = { transcribe: async () => "ok" };
    const tts: Tts = { synthesize: async (text) => new Uint8Array([text.charCodeAt(0)]) };
    const ch = createVoiceChannel({
      transport,
      stt,
      tts,
      dispatchHandlerTimeoutMs: 50,
    });
    // First handler: hangs forever on its first invocation, then tries
    // to speak when finally released — must be fenced.
    let releaseHung: (() => void) | undefined;
    let firstHandlerSawTurn = 0;
    let hungAttemptedSpeak = false;
    let hungRejected = false;
    ch.onMessage(async (msg) => {
      firstHandlerSawTurn++;
      if (firstHandlerSawTurn === 1) {
        await new Promise<void>((r) => {
          releaseHung = r;
        });
        hungAttemptedSpeak = true;
        try {
          await ch.send({
            threadId: msg.threadId ?? "call-A",
            content: [{ kind: "text", text: "X" }],
          });
        } catch (e) {
          hungRejected = e instanceof VoicePoisonedSessionError;
        }
      }
    });
    // Second handler: also async but settles fast. Under the broken
    // implementation the second handler's token would be the only one
    // tracked — its quick settle would never trigger the watchdog and
    // the first handler's late send would slip through unfenced.
    let secondHandlerSawTurn = 0;
    ch.onMessage(async (msg) => {
      secondHandlerSawTurn++;
      if (secondHandlerSawTurn === 2) {
        await ch.send({
          threadId: msg.threadId ?? "call-A",
          content: [{ kind: "text", text: "B" }],
        });
      }
    });
    await ch.connect();
    listener?.("call-A", new Uint8Array([1]));
    listener?.("call-A", new Uint8Array([2]));
    // Wait past the watchdog and turn B's send.
    await new Promise((r) => setTimeout(r, 250));
    expect(secondHandlerSawTurn).toBe(2); // the watchdog admitted turn 2
    expect(sentBy).toEqual([`[${"B".charCodeAt(0)}]`]); // only B spoke
    // Release the hung first handler — its late send must be fenced.
    releaseHung?.();
    await new Promise((r) => setTimeout(r, 50));
    expect(hungAttemptedSpeak).toBe(true);
    expect(hungRejected).toBe(true);
    expect(sentBy).toEqual([`[${"B".charCodeAt(0)}]`]); // X never spoke
    await ch.disconnect();
  });

  test("watchdog-expired turn cannot speak audio after the session moves on", async () => {
    // Regression (round 32 high): the watchdog dropped per-session
    // ordering after timeout but did NOT fence the stuck handler. If
    // turn A eventually woke and called ch.send(), its audio would be
    // serialized behind turn B's — out of order, possibly overlapping.
    // The fence must reject any send from a turn the watchdog already
    // expired so a slow tool/model call cannot speak into the next
    // turn on the same session.
    let listener: ((sessionId: string, audio: Uint8Array) => void) | undefined;
    const sentBy: string[] = [];
    const transport: VoiceTransport = {
      connect: async () => {},
      disconnect: async () => {},
      sendUtterance: async (_s, _u, frames) => {
        for (const f of frames) sentBy.push(`[${f[0]}]`);
      },
      onUtterance: (h) => {
        listener = h;
        return () => {
          listener = undefined;
        };
      },
    };
    const stt: Stt = { transcribe: async () => "ok" };
    const tts: Tts = { synthesize: async (text) => new Uint8Array([text.charCodeAt(0)]) };
    const ch = createVoiceChannel({
      transport,
      stt,
      tts,
      dispatchHandlerTimeoutMs: 50,
    });
    // let requires justification: each handler needs to hold its own controller
    let releaseA: (() => void) | undefined;
    let aRejected = false;
    let firstSeen = false;
    ch.onMessage(async (msg) => {
      const tid = msg.threadId ?? "call-A";
      if (!firstSeen) {
        firstSeen = true;
        await new Promise<void>((r) => {
          releaseA = r;
        });
        try {
          await ch.send({ threadId: tid, content: [{ kind: "text", text: "A" }] });
        } catch (e) {
          aRejected = e instanceof VoicePoisonedSessionError;
        }
      } else {
        await ch.send({ threadId: tid, content: [{ kind: "text", text: "B" }] });
      }
    });
    await ch.connect();
    listener?.("call-A", new Uint8Array([1]));
    listener?.("call-A", new Uint8Array([2]));
    // Wait past watchdog + B's send.
    await new Promise((r) => setTimeout(r, 200));
    // Now release A; its send must be rejected with VoicePoisonedSessionError.
    releaseA?.();
    await new Promise((r) => setTimeout(r, 50));
    expect(aRejected).toBe(true);
    // Only B's audio reached the transport — A never spoke.
    expect(sentBy).toEqual([`[${"B".charCodeAt(0)}]`]);
    await ch.disconnect();
  });

  test("hung onMessage handler does not wedge later utterances forever (dispatch watchdog)", async () => {
    // Regression (round 31 high): full-pipeline ordering awaited inFlight
    // unconditionally. A handler that never settled would wedge every
    // later utterance on the same sessionId behind a dead promise. The
    // dispatch watchdog must surrender ordering after the configured
    // timeout so the next utterance can proceed even if the prior
    // handler is permanently stuck.
    let listener: ((sessionId: string, audio: Uint8Array) => void) | undefined;
    const transport: VoiceTransport = {
      connect: async () => {},
      disconnect: async () => {},
      sendUtterance: async () => {},
      onUtterance: (h) => {
        listener = h;
        return () => {
          listener = undefined;
        };
      },
    };
    const stt: Stt = { transcribe: async () => "ok" };
    const tts: Tts = { synthesize: async () => new Uint8Array() };
    const ch = createVoiceChannel({
      transport,
      stt,
      tts,
      // Tight watchdog so the test runs fast.
      dispatchHandlerTimeoutMs: 50,
    });
    const dispatched: string[] = [];
    let firstHandlerStarted = false;
    ch.onMessage(async (msg) => {
      const text = msg.content[0]?.kind === "text" ? msg.content[0].text : "?";
      dispatched.push(text);
      if (!firstHandlerStarted) {
        firstHandlerStarted = true;
        // Permanently hung handler — never resolves.
        await new Promise(() => {});
      }
    });
    await ch.connect();
    listener?.("call-A", new Uint8Array([1]));
    listener?.("call-A", new Uint8Array([2]));
    // Wait long enough for STT, the watchdog (50ms), and the next
    // utterance to dispatch. Both should land even though the first
    // handler never settles.
    await new Promise((r) => setTimeout(r, 250));
    expect(dispatched.length).toBe(2);
    await ch.disconnect();
  });

  test("stampForCurrentCall lets server-initiated outbound survive the post-reconnect epoch fence (round-40 high)", async () => {
    // Round-40 high: post-reconnect, the wrappedSend epoch fence rejects
    // any send made outside an inbound's ALS scope unless metadata
    // carries the current connectGen. Without a public API to mint that
    // tag, legitimate server-initiated speech (welcome prompt, externally
    // triggered prompt, queued resume) was indistinguishable from a
    // stale leak and rejected. `stampForCurrentCall` is the supported
    // helper — it stamps the live connectGen so the send passes the fence.
    const h = harness();
    const ch = createVoiceChannel({ transport: h.transport, stt: h.stt, tts: h.tts });
    await ch.connect();
    await ch.disconnect(); // bumps connectGen → 1
    await ch.connect();
    expect(ch.currentCallEpoch()).toBe(1);
    // A bare send without a tag would now reject (epoch fence active).
    await expect(
      ch.send({ threadId: "session-1", content: [{ kind: "text", text: "would reject" }] }),
    ).rejects.toBeInstanceOf(VoicePoisonedSessionError);
    // Same outbound stamped via the public helper passes the fence.
    const stamped = ch.stampForCurrentCall({
      threadId: "session-1",
      content: [{ kind: "text", text: "welcome back" }],
    });
    await ch.send(stamped);
    expect(h.sentUtterances).toHaveLength(1);
    await ch.disconnect();
  });
});
