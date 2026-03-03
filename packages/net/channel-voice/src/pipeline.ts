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
  // let requires justification: transcript handler list updated by onTranscript and its unsubscribe
  let transcriptHandlers: readonly ((event: TranscriptEvent) => void)[] = [];
  // let requires justification: AgentSession reference created on start, destroyed on stop
  let session: { say: (text: string) => unknown; close: () => Promise<void> } | undefined;

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
    };
    running = true;
  };

  const stop = async (): Promise<void> => {
    if (!running) {
      return; // no-op when not running
    }
    running = false;
    if (session !== undefined) {
      await session.close();
      session = undefined;
    }
  };

  const speak = async (text: string): Promise<void> => {
    if (session === undefined) {
      throw new Error("Pipeline not started — call start() before speak()");
    }
    session.say(text);
  };

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

  return { start, stop, speak, onTranscript, isRunning };
}
