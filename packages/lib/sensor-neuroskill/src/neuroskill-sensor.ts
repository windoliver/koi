import type { SignalSource, UserSignal } from "@koi/core";

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

function roundMetric(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1000) / 1000;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return roundMetric(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function validateFrame(input: unknown, maxSamples: number): NeuroSignalFrame | null {
  if (!isRecord(input)) return null;
  const timestamp = input.timestamp;
  const samplingRateHz = input.samplingRateHz;
  const channels = input.channels;
  if (typeof timestamp !== "number" || typeof samplingRateHz !== "number") return null;
  if (!Number.isFinite(timestamp) || !Number.isFinite(samplingRateHz)) return null;
  if (samplingRateHz <= 0 || !Array.isArray(channels) || channels.length === 0) return null;

  const parsedChannels = channels.flatMap((channel): readonly NeuroSignalChannel[] => {
    if (!isRecord(channel)) return [];
    const name = channel.name;
    const rawSamples = channel.samples;
    if (typeof name !== "string" || name.length === 0 || !Array.isArray(rawSamples)) return [];
    if (!rawSamples.every((sample) => typeof sample === "number" && Number.isFinite(sample))) {
      return [];
    }
    const samples = rawSamples.slice(0, maxSamples);
    if (samples.length === 0) return [];
    const type = typeof channel.type === "string" ? channel.type : "unknown";
    return [{ name, type: normalizeKind(type), samples }];
  });

  if (parsedChannels.length === 0) return null;
  return { timestamp, samplingRateHz, channels: parsedChannels };
}

function normalizeKind(kind: string): NeuroSignalKind {
  if (kind === "eeg" || kind === "emg" || kind === "eog" || kind === "ecg") return kind;
  return "unknown";
}

function mean(samples: readonly number[]): number {
  if (samples.length === 0) return 0;
  return samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
}

function median(samples: readonly number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const midpoint = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[midpoint] ?? 0;
  return ((sorted[midpoint - 1] ?? 0) + (sorted[midpoint] ?? 0)) / 2;
}

function variance(samples: readonly number[], sampleMean: number): number {
  if (samples.length === 0) return 0;
  return samples.reduce((sum, sample) => sum + (sample - sampleMean) ** 2, 0) / samples.length;
}

function rms(samples: readonly number[]): number {
  if (samples.length === 0) return 0;
  return Math.sqrt(samples.reduce((sum, sample) => sum + sample ** 2, 0) / samples.length);
}

function removeNoise(
  samples: readonly number[],
  sigma: number,
): { readonly samples: readonly number[]; readonly rejected: number } {
  const baseline = median(samples);
  const centered = samples.map((sample) => sample - baseline);
  const absoluteDeviations = centered.map((sample) => Math.abs(sample));
  const robustStd = median(absoluteDeviations) * 1.4826;
  const limit = robustStd > 0 ? robustStd * sigma : sigma;
  const rejected = centered.filter((sample) => Math.abs(sample) > limit).length;
  return {
    samples: centered.map((sample) => Math.max(-limit, Math.min(limit, sample))),
    rejected,
  };
}

function zeroCrossingRate(samples: readonly number[]): number {
  if (samples.length < 2) return 0;
  const crossings = samples.slice(1).filter((sample, index) => {
    const previous = samples[index] ?? 0;
    return (previous < 0 && sample >= 0) || (previous >= 0 && sample < 0);
  }).length;
  return roundMetric(crossings / (samples.length - 1));
}

function computeBandPowers(samples: readonly number[], samplingRateHz: number): NeuroBandPowers {
  const bins = samples.map((_, index) => index).slice(1, Math.floor(samples.length / 2) + 1);
  const powers = bins.map((bin) => {
    const frequency = (bin * samplingRateHz) / samples.length;
    const real = samples.reduce(
      (sum, sample, index) => sum + sample * Math.cos((2 * Math.PI * bin * index) / samples.length),
      0,
    );
    const imaginary = samples.reduce(
      (sum, sample, index) => sum - sample * Math.sin((2 * Math.PI * bin * index) / samples.length),
      0,
    );
    return { frequency, power: real ** 2 + imaginary ** 2 };
  });

  const sumBand = (low: number, high: number): number =>
    roundMetric(
      powers
        .filter((entry) => entry.frequency >= low && entry.frequency < high)
        .reduce((sum, entry) => sum + entry.power, 0),
    );

  return {
    delta: sumBand(0.5, 4),
    theta: sumBand(4, 8),
    alpha: sumBand(8, 13),
    beta: sumBand(13, 30),
    gamma: sumBand(30, 100),
  };
}

function extractFeatures(frame: NeuroSignalFrame, cfg: ResolvedConfig): NeuroSignalFeatures {
  return {
    timestamp: frame.timestamp,
    samplingRateHz: frame.samplingRateHz,
    channels: frame.channels.map((channel) => {
      const filtered = removeNoise(channel.samples, cfg.noiseSigma);
      const sampleMean = mean(filtered.samples);
      const sampleVariance = variance(filtered.samples, sampleMean);
      const peakAmplitude = filtered.samples.reduce(
        (peak, sample) => Math.max(peak, Math.abs(sample)),
        0,
      );
      return {
        name: channel.name,
        type: channel.type ?? "unknown",
        sampleCount: filtered.samples.length,
        mean: roundMetric(sampleMean),
        rms: roundMetric(rms(filtered.samples)),
        variance: roundMetric(sampleVariance),
        peakAmplitude: roundMetric(peakAmplitude),
        zeroCrossingRate: zeroCrossingRate(filtered.samples),
        noiseRejectedSamples: filtered.rejected,
        bandPowers: computeBandPowers(filtered.samples, frame.samplingRateHz),
      };
    }),
  };
}

function aggregateBand(features: NeuroSignalFeatures, band: keyof NeuroBandPowers): number {
  const eeg = features.channels.filter((channel) => channel.type === "eeg");
  if (eeg.length === 0) return 0;
  return eeg.reduce((sum, channel) => sum + channel.bandPowers[band], 0) / eeg.length;
}

function estimateCognitiveState(
  features: NeuroSignalFeatures,
  sampledAt: number,
): CognitiveStateEstimate {
  const theta = aggregateBand(features, "theta");
  const alpha = aggregateBand(features, "alpha");
  const beta = aggregateBand(features, "beta");
  const gamma = aggregateBand(features, "gamma");
  const total = theta + alpha + beta + gamma;
  const confidence = clamp01(features.channels.length / 4);
  if (total <= 0) return { ...EMPTY_STATE, sampledAt };

  const attention = clamp01((beta + gamma) / total);
  const fatigue = clamp01((theta + alpha * 0.5) / total);
  const engagement = clamp01((beta + alpha) / total);
  return { attention, fatigue, engagement, confidence, sampledAt };
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

export function createNeuroSkillSensor(config: NeuroSkillSensorConfig = {}): NeuroSkillSensor {
  const cfg = resolveConfig(config);
  const subscribers = new Set<NeuroSkillSubscriber>();
  // Mutable state is held inside the sensor instance; public snapshots are immutable copies.
  const state: MutableState = {
    connectionState: "idle",
    socket: undefined,
    events: [],
    rejectedFrames: 0,
    latestFeatures: EMPTY_FEATURES,
    cognitiveState: EMPTY_STATE,
  };

  const rejectFrame = (): false => {
    state.rejectedFrames += 1;
    return false;
  };

  const record = (frameInput: unknown): boolean => {
    const frame = validateFrame(frameInput, cfg.maxSamplesPerChannel);
    if (frame === null) return rejectFrame();
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

  const snapshot = (): NeuroSkillSnapshot => {
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

  return {
    name: cfg.name,
    connect(url) {
      state.socket?.close?.();
      const socket = (cfg.socketFactory ?? defaultSocketFactory)(url);
      state.socket = socket;
      state.connectionState = "connected";
      const onMessage = (event: { readonly data?: unknown }): void => {
        const parsed = parseJson(event.data);
        if (parsed === null) {
          rejectFrame();
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
      if (socket.addEventListener !== undefined) {
        socket.addEventListener("message", onMessage);
        socket.addEventListener("close", onClose);
        socket.addEventListener("error", onError);
      }
      socket.onmessage = onMessage;
      socket.onclose = onClose;
      socket.onerror = onError;
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
