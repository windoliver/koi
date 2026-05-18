import type { SignalSource, UserSignal } from "@koi/core";
import { estimateCognitiveState, extractFeatures, validateFrame } from "./signal-processing.js";

export type NeuroSignalKind = "eeg" | "emg" | "eog" | "ecg" | "unknown";
export type NeuroSkillConnectionState = "idle" | "connected" | "disconnected" | "error";

export interface NeuroSignalChannel {
  readonly name: string;
  readonly type?: NeuroSignalKind | undefined;
  readonly samples: readonly number[];
}

export interface NeuroSignalFrame {
  readonly timestamp: number;
  readonly samplingRateHz: number;
  readonly channels: readonly NeuroSignalChannel[];
}

export interface NeuroBandPowers {
  readonly delta: number;
  readonly theta: number;
  readonly alpha: number;
  readonly beta: number;
  readonly gamma: number;
}

export interface NeuroChannelFeatures {
  readonly name: string;
  readonly type: NeuroSignalKind;
  readonly sampleCount: number;
  readonly mean: number;
  readonly rms: number;
  readonly variance: number;
  readonly peakAmplitude: number;
  readonly zeroCrossingRate: number;
  readonly noiseRejectedSamples: number;
  readonly bandPowers: NeuroBandPowers;
}

export interface NeuroSignalFeatures {
  readonly timestamp: number;
  readonly samplingRateHz: number;
  readonly channels: readonly NeuroChannelFeatures[];
}

export interface CognitiveStateEstimate {
  readonly attention: number;
  readonly fatigue: number;
  readonly engagement: number;
  readonly confidence: number;
  readonly sampledAt: number;
}

export interface NeuroSkillStateEvent {
  readonly kind: "cognitive_state";
  readonly timestamp: number;
  readonly features: NeuroSignalFeatures;
  readonly state: CognitiveStateEstimate;
}

export interface NeuroSkillEventSummary {
  readonly kind: NeuroSkillStateEvent["kind"];
  readonly timestamp: number;
}

export interface NeuroSkillSnapshot {
  readonly [key: string]: unknown;
  readonly connectionState: NeuroSkillConnectionState;
  readonly cognitiveState: CognitiveStateEstimate;
  readonly latestFeatures: NeuroSignalFeatures;
  readonly recentEvents: readonly NeuroSkillEventSummary[];
  readonly retainedEventCount: number;
  readonly rejectedFrames: number;
  readonly sampledAt: number;
  readonly windowMs: number;
}

export interface NeuroSkillSocket {
  readonly close?: (() => void) | undefined;
  readonly addEventListener?: (
    type: "message" | "close" | "error",
    handler: (event: { readonly data?: unknown }) => void,
  ) => void;
  onmessage?: ((event: { readonly data?: unknown }) => void) | undefined;
  onclose?: (() => void) | undefined;
  onerror?: (() => void) | undefined;
}

export type NeuroSkillSocketFactory = (url: string) => NeuroSkillSocket;

export interface NeuroSkillSensorConfig {
  readonly name?: string | undefined;
  readonly source?: string | undefined;
  readonly now?: (() => number) | undefined;
  readonly socketFactory?: NeuroSkillSocketFactory | undefined;
  readonly windowMs?: number | undefined;
  readonly maxEvents?: number | undefined;
  readonly maxSamplesPerChannel?: number | undefined;
  readonly noiseSigma?: number | undefined;
}

export interface NeuroSkillSensor extends SignalSource {
  readonly connect: (url: string) => void;
  readonly disconnect: () => void;
  readonly record: (frame: unknown) => boolean;
  readonly subscribe: (handler: (event: NeuroSkillStateEvent) => void) => () => void;
  readonly snapshot: () => NeuroSkillSnapshot;
  readonly clear: () => void;
}

interface ResolvedConfig {
  readonly name: string;
  readonly source: string;
  readonly now: () => number;
  readonly socketFactory: NeuroSkillSocketFactory | undefined;
  readonly windowMs: number;
  readonly maxEvents: number;
  readonly maxSamplesPerChannel: number;
  readonly noiseSigma: number;
}

interface MutableState {
  connectionState: NeuroSkillConnectionState;
  socket: NeuroSkillSocket | undefined;
  events: readonly NeuroSkillStateEvent[];
  rejectedFrames: number;
  latestFeatures: NeuroSignalFeatures;
  cognitiveState: CognitiveStateEstimate;
}

type NeuroSkillSubscriber = (event: NeuroSkillStateEvent) => void;

const DEFAULT_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_MAX_EVENTS = 256;
const DEFAULT_MAX_SAMPLES_PER_CHANNEL = 512;
const DEFAULT_NOISE_SIGMA = 6;
const EMPTY_FEATURES: NeuroSignalFeatures = {
  timestamp: 0,
  samplingRateHz: 0,
  channels: [],
};
const EMPTY_STATE: CognitiveStateEstimate = {
  attention: 0,
  fatigue: 0,
  engagement: 0,
  confidence: 0,
  sampledAt: 0,
};

function positiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function positiveNumber(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

function resolveConfig(config: NeuroSkillSensorConfig): ResolvedConfig {
  return {
    name: config.name ?? "neuroskill",
    source: config.source ?? "neuroskill",
    now: config.now ?? Date.now,
    socketFactory: config.socketFactory,
    windowMs: positiveInt(config.windowMs, DEFAULT_WINDOW_MS),
    maxEvents: positiveInt(config.maxEvents, DEFAULT_MAX_EVENTS),
    maxSamplesPerChannel: positiveInt(config.maxSamplesPerChannel, DEFAULT_MAX_SAMPLES_PER_CHANNEL),
    noiseSigma: positiveNumber(config.noiseSigma, DEFAULT_NOISE_SIGMA),
  };
}

function parseJson(data: unknown): unknown {
  if (typeof data !== "string") return data;
  try {
    const parsed: unknown = JSON.parse(data);
    return parsed;
  } catch {
    return null;
  }
}

function pruneEvents(
  events: readonly NeuroSkillStateEvent[],
  cfg: ResolvedConfig,
  now: number,
): readonly NeuroSkillStateEvent[] {
  const cutoff = now - cfg.windowMs;
  return events
    .filter((event) => event.timestamp >= cutoff && event.timestamp <= now)
    .slice(-cfg.maxEvents);
}

function notifySubscribers(
  subscribers: ReadonlySet<NeuroSkillSubscriber>,
  event: NeuroSkillStateEvent,
): void {
  for (const subscriber of subscribers) {
    try {
      subscriber(event);
    } catch {
      // Sensor consumers are isolated so one broken stream listener cannot stop ingestion.
    }
  }
}

function wrapSocket(raw: unknown): NeuroSkillSocket {
  if ((typeof raw !== "object" && typeof raw !== "function") || raw === null) {
    throw new Error("WebSocket constructor returned a non-object socket");
  }

  return {
    close() {
      const close = Reflect.get(raw, "close");
      if (typeof close === "function") Reflect.apply(close, raw, []);
    },
    addEventListener(type, handler) {
      const addEventListener = Reflect.get(raw, "addEventListener");
      if (typeof addEventListener !== "function") return;
      Reflect.apply(addEventListener, raw, [type, handler]);
    },
  };
}

function defaultSocketFactory(url: string): NeuroSkillSocket {
  const maybeWebSocket: unknown = Reflect.get(globalThis, "WebSocket");
  if (typeof maybeWebSocket !== "function") {
    throw new Error("WebSocket is unavailable; pass socketFactory to createNeuroSkillSensor");
  }
  return wrapSocket(Reflect.construct(maybeWebSocket, [url]));
}

function createInitialState(): MutableState {
  return {
    connectionState: "idle",
    socket: undefined,
    events: [],
    rejectedFrames: 0,
    latestFeatures: EMPTY_FEATURES,
    cognitiveState: EMPTY_STATE,
  };
}

function rejectFrame(state: MutableState): false {
  state.rejectedFrames += 1;
  return false;
}

function createRecorder(
  state: MutableState,
  cfg: ResolvedConfig,
  subscribers: ReadonlySet<NeuroSkillSubscriber>,
): (frame: unknown) => boolean {
  return (frameInput: unknown): boolean => {
    const frame = validateFrame(frameInput, cfg.maxSamplesPerChannel);
    if (frame === null) return rejectFrame(state);
    const features = extractFeatures(frame, cfg);
    const cognitiveState = estimateCognitiveState(features, cfg.now());
    const event: NeuroSkillStateEvent = {
      kind: "cognitive_state",
      timestamp: frame.timestamp,
      features,
      state: cognitiveState,
    };
    state.latestFeatures = features;
    state.cognitiveState = cognitiveState;
    state.events = pruneEvents([...state.events, event], cfg, cfg.now());
    notifySubscribers(subscribers, event);
    return true;
  };
}

function createSnapshotReader(state: MutableState, cfg: ResolvedConfig): () => NeuroSkillSnapshot {
  return () => {
    const now = cfg.now();
    state.events = pruneEvents(state.events, cfg, now);
    return {
      connectionState: state.connectionState,
      cognitiveState: state.cognitiveState,
      latestFeatures: state.latestFeatures,
      recentEvents: state.events.map((event) => ({
        kind: event.kind,
        timestamp: event.timestamp,
      })),
      retainedEventCount: state.events.length,
      rejectedFrames: state.rejectedFrames,
      sampledAt: now,
      windowMs: cfg.windowMs,
    };
  };
}

function attachSocketHandlers(
  socket: NeuroSkillSocket,
  state: MutableState,
  record: (frame: unknown) => boolean,
): void {
  const onMessage = (event: { readonly data?: unknown }): void => {
    const parsed = parseJson(event.data);
    if (parsed === null) {
      rejectFrame(state);
      return;
    }
    record(parsed);
  };
  const onClose = (): void => {
    state.connectionState = "disconnected";
  };
  const onError = (): void => {
    state.connectionState = "error";
  };
  socket.addEventListener?.("message", onMessage);
  socket.addEventListener?.("close", onClose);
  socket.addEventListener?.("error", onError);
  socket.onmessage = onMessage;
  socket.onclose = onClose;
  socket.onerror = onError;
}

export function createNeuroSkillSensor(config: NeuroSkillSensorConfig = {}): NeuroSkillSensor {
  const cfg = resolveConfig(config);
  const subscribers = new Set<NeuroSkillSubscriber>();
  const state = createInitialState();
  const record = createRecorder(state, cfg, subscribers);
  const snapshot = createSnapshotReader(state, cfg);

  return {
    name: cfg.name,
    connect(url) {
      state.socket?.close?.();
      const socket = (cfg.socketFactory ?? defaultSocketFactory)(url);
      state.socket = socket;
      state.connectionState = "connected";
      attachSocketHandlers(socket, state, record);
    },
    disconnect() {
      state.socket?.close?.();
      state.socket = undefined;
      state.connectionState = "disconnected";
    },
    record,
    subscribe(handler) {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },
    snapshot,
    read(): UserSignal {
      return {
        kind: "sensor",
        source: cfg.source,
        values: snapshot(),
      };
    },
    clear() {
      state.events = [];
      state.rejectedFrames = 0;
      state.latestFeatures = EMPTY_FEATURES;
      state.cognitiveState = EMPTY_STATE;
    },
  };
}
