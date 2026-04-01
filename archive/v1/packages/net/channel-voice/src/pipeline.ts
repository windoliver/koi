/**
 * VoicePipeline interface and LiveKit Agents implementation.
 *
 * The VoicePipeline interface abstracts the voice processing pipeline so tests
 * can substitute a mock without LiveKit dependencies. The LiveKit implementation
 * uses @livekit/agents Agent + AgentSession with STT/TTS plugins.
 *
 * All LiveKit-specific types stay in this file — they never leak to the
 * public API. Dynamic imports keep the heavy native deps (rtc-node) lazy.
 */

import type { VoiceChannelConfig } from "./config.js";

// ---------------------------------------------------------------------------
// TranscriptEvent — raw speech-to-text output
// ---------------------------------------------------------------------------

export interface TranscriptEvent {
  readonly text: string;
  readonly isFinal: boolean;
  readonly participantId: string;
  readonly confidence?: number;
}

// ---------------------------------------------------------------------------
// VoicePipeline — thin abstraction over voice processing
// ---------------------------------------------------------------------------

export interface VoicePipeline {
  /** Join a LiveKit room and start processing audio. */
  readonly start: (roomName: string) => Promise<void>;
  /** Leave the room and release resources. */
  readonly stop: () => Promise<void>;
  /** Synthesize and play text as speech in the room. */
  readonly speak: (text: string) => Promise<void>;
  /** Register a transcript handler. Returns unsubscribe function. */
  readonly onTranscript: (handler: (event: TranscriptEvent) => void) => () => void;
  /** Whether the pipeline is currently running in a room. */
  readonly isRunning: () => boolean;
  /** Abort current TTS playback. No-op if not speaking. Sync for minimal latency. */
  readonly interrupt: () => void;
  /** Whether TTS is currently playing audio. */
  readonly isSpeaking: () => boolean;
}

// ---------------------------------------------------------------------------
// LiveKit Agents implementation
// ---------------------------------------------------------------------------

/**
 * Builds STT/TTS plugin option objects from our validated config.
 *
 * Uses explicit Record<string, unknown> construction to avoid
 * exactOptionalPropertyTypes conflicts with third-party SDK types
 * that don't opt into this strictness. Config values are already
 * validated by validateVoiceConfig() before reaching here.
 */
function buildSttOptions(config: VoiceChannelConfig): Record<string, unknown> {
  const opts: Record<string, unknown> = { apiKey: config.stt.apiKey };
  if (config.stt.language !== undefined) {
    opts.language = config.stt.language;
  }
  if (config.stt.model !== undefined) {
    opts.model = config.stt.model;
  }
  return opts;
}

function buildTtsOptions(config: VoiceChannelConfig): Record<string, unknown> {
  const opts: Record<string, unknown> = { apiKey: config.tts.apiKey };
  if (config.tts.voice !== undefined) {
    opts.voice = config.tts.voice;
  }
  if (config.tts.model !== undefined) {
    opts.model = config.tts.model;
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Type guards for dynamic LiveKit return values
// ---------------------------------------------------------------------------

interface SpeechHandle {
  readonly interrupt: () => void;
}

interface Thenable {
  readonly then: (onFulfill: () => void, onReject: () => void) => unknown;
}

function isSpeechHandle(value: unknown): value is SpeechHandle {
  return (
    value !== null &&
    typeof value === "object" &&
    "interrupt" in value &&
    typeof (value as Record<string, unknown>).interrupt === "function"
  );
}

function isThenable(value: unknown): value is Thenable {
  return (
    value !== null &&
    typeof value === "object" &&
    "then" in value &&
    typeof (value as Record<string, unknown>).then === "function"
  );
}

/**
 * Creates a VoicePipeline backed by LiveKit Agents (v1.0).
 *
 * Uses AgentSession + Agent with STT/TTS plugins. STT and TTS are
 * instantiated based on config provider settings. The session emits
 * `user_input_transcribed` events which are mapped to TranscriptEvents.
 */
export function createLiveKitPipeline(config: VoiceChannelConfig): VoicePipeline {
  // let requires justification: mutable running state managed by start/stop lifecycle
  let running = false;
  // let requires justification: mutable speaking state managed by speak/interrupt/stop
  let speaking = false;
  // let requires justification: transcript handler list updated by onTranscript and its unsubscribe
  let transcriptHandlers: readonly ((event: TranscriptEvent) => void)[] = [];
  // let requires justification: AgentSession reference created on start, destroyed on stop
  let session:
    | {
        readonly say: (text: string) => unknown;
        readonly close: () => Promise<void>;
        readonly interrupt: () => void;
      }
    | undefined;
  // let requires justification: holds current SpeechHandle for interrupt, replaced per speak call
  let currentSpeechHandle: { readonly interrupt: () => void } | undefined;

  const createSttPlugin = async (): Promise<unknown> => {
    const opts = buildSttOptions(config);
    if (config.stt.provider === "deepgram") {
      const mod = await import("@livekit/agents-plugin-deepgram");
      return new mod.STT(opts);
    }
    const mod = await import("@livekit/agents-plugin-openai");
    return new mod.STT(opts);
  };

  const createTtsPlugin = async (): Promise<unknown> => {
    const opts = buildTtsOptions(config);
    if (config.tts.provider === "openai") {
      const mod = await import("@livekit/agents-plugin-openai");
      return new mod.TTS(opts);
    }
    const mod = await import("@livekit/agents-plugin-deepgram");
    return new mod.TTS(opts);
  };

  const dispatchTranscript = (text: string, isFinal: boolean, speakerId: string | null): void => {
    const event: TranscriptEvent = {
      text,
      isFinal,
      participantId: speakerId ?? "user",
    };
    const currentHandlers = transcriptHandlers;
    for (const handler of currentHandlers) {
      handler(event);
    }
  };

  const start = async (_roomName: string): Promise<void> => {
    if (running) {
      return; // idempotent
    }

    const sttPlugin = await createSttPlugin();
    const ttsPlugin = await createTtsPlugin();

    const voiceMod = await import("@livekit/agents").then((m) => m.voice);
    const { AgentSessionEventTypes } = await import("@livekit/agents").then((m) => m.voice);

    // Create a minimal agent with STT/TTS configuration
    const agent = new voiceMod.Agent({
      instructions: "Voice channel agent",
      // @ts-expect-error — stt/tts plugins are dynamically imported; type narrowing not possible across dynamic import boundary
      stt: sttPlugin,
      // @ts-expect-error — stt/tts plugins are dynamically imported; type narrowing not possible across dynamic import boundary
      tts: ttsPlugin,
    });

    const agentSession = new voiceMod.AgentSession({
      // @ts-expect-error — stt/tts plugins are dynamically imported; type narrowing not possible across dynamic import boundary
      stt: sttPlugin,
      // @ts-expect-error — stt/tts plugins are dynamically imported; type narrowing not possible across dynamic import boundary
      tts: ttsPlugin,
    });

    // Listen for user input transcriptions using the enum key
    agentSession.on(AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      dispatchTranscript(ev.transcript, ev.isFinal, ev.speakerId);
    });

    // Start session (headless — no Room for testing).
    // In production, a Room from @livekit/rtc-node would be provided.
    await agentSession.start({ agent });

    session = {
      say: (text: string) => agentSession.say(text),
      close: () => agentSession.close(),
      interrupt: () => agentSession.interrupt(),
    };
    running = true;
  };

  const stop = async (): Promise<void> => {
    if (!running) {
      return; // no-op when not running
    }
    running = false;
    speaking = false;
    currentSpeechHandle = undefined;
    if (session !== undefined) {
      await session.close();
      session = undefined;
    }
  };

  const speak = async (text: string): Promise<void> => {
    if (session === undefined) {
      throw new Error("Pipeline not started — call start() before speak()");
    }
    speaking = true;
    const handle = session.say(text);
    // LiveKit's say() returns a SpeechHandle with interrupt()
    if (isSpeechHandle(handle)) {
      currentSpeechHandle = handle;
    }
    // Capture reference for completion callback identity check
    const capturedHandle = currentSpeechHandle;
    // Reset speaking when playback completes naturally (handle may be thenable)
    if (isThenable(handle)) {
      const onComplete = (): void => {
        // Only clear if this handle is still current (not replaced by new speak)
        if (currentSpeechHandle === capturedHandle) {
          speaking = false;
          currentSpeechHandle = undefined;
        }
      };
      handle.then(onComplete, onComplete);
    }
  };

  const interrupt = (): void => {
    if (!speaking) {
      return; // no-op when not speaking
    }
    speaking = false;
    if (currentSpeechHandle !== undefined) {
      currentSpeechHandle.interrupt();
      currentSpeechHandle = undefined;
    }
    if (session !== undefined) {
      session.interrupt();
    }
  };

  const isSpeaking = (): boolean => speaking;

  const onTranscript = (handler: (event: TranscriptEvent) => void): (() => void) => {
    transcriptHandlers = [...transcriptHandlers, handler];
    // let requires justification: one-shot guard to prevent double-unsubscribe
    let removed = false;
    return (): void => {
      if (removed) {
        return;
      }
      removed = true;
      transcriptHandlers = transcriptHandlers.filter((h) => h !== handler);
    };
  };

  const isRunning = (): boolean => running;

  return { start, stop, speak, onTranscript, isRunning, interrupt, isSpeaking };
}
