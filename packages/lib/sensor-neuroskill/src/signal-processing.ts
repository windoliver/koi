import type {
  CognitiveStateEstimate,
  NeuroBandPowers,
  NeuroSignalFeatures,
  NeuroSignalFrame,
  NeuroSignalKind,
} from "./neuroskill-sensor.js";

interface ProcessingConfig {
  readonly maxSamplesPerChannel: number;
  readonly noiseSigma: number;
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

function normalizeKind(kind: string): NeuroSignalKind {
  if (kind === "eeg" || kind === "emg" || kind === "eog" || kind === "ecg") return kind;
  return "unknown";
}

export function validateFrame(input: unknown, maxSamples: number): NeuroSignalFrame | null {
  if (!isRecord(input)) return null;
  const { timestamp, samplingRateHz, channels } = input;
  if (typeof timestamp !== "number" || typeof samplingRateHz !== "number") return null;
  if (!Number.isFinite(timestamp) || !Number.isFinite(samplingRateHz)) return null;
  if (samplingRateHz <= 0 || !Array.isArray(channels) || channels.length === 0) return null;

  const parsedChannels = channels.flatMap((channel) => {
    if (!isRecord(channel)) return [];
    const { name, samples: rawSamples } = channel;
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

export function extractFeatures(
  frame: NeuroSignalFrame,
  cfg: ProcessingConfig,
): NeuroSignalFeatures {
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

export function estimateCognitiveState(
  features: NeuroSignalFeatures,
  sampledAt: number,
): CognitiveStateEstimate {
  const theta = aggregateBand(features, "theta");
  const alpha = aggregateBand(features, "alpha");
  const beta = aggregateBand(features, "beta");
  const gamma = aggregateBand(features, "gamma");
  const total = theta + alpha + beta + gamma;
  const confidence = clamp01(features.channels.length / 4);
  if (total <= 0) {
    return { attention: 0, fatigue: 0, engagement: 0, confidence: 0, sampledAt };
  }

  const attention = clamp01((beta + gamma) / total);
  const fatigue = clamp01((theta + alpha * 0.5) / total);
  const engagement = clamp01((beta + alpha) / total);
  return { attention, fatigue, engagement, confidence, sampledAt };
}
