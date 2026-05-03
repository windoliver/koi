import type { SignalSource, UserSignal } from "@koi/core";

export interface SourceSignal {
  /** The configured `SignalSource.name` that produced this signal. */
  readonly sourceName: string;
  readonly signal: Extract<UserSignal, { kind: "sensor" }>;
}

export interface SignalReadResult {
  /** Sensor signals from sources that succeeded, paired with their source name. */
  readonly signals: readonly SourceSignal[];
  /** Names of sources that failed, timed out, or returned a non-sensor `UserSignal` kind. */
  readonly failedSources: readonly string[];
}

/**
 * Read all signal sources in parallel with a per-source timeout.
 *
 * The contract is "sensor enrichment only": sources may legally return any
 * `UserSignal` shape per the L0 type, but this middleware treats SignalSources
 * as a sensor channel. Returns of `kind !== "sensor"` are rejected at the
 * boundary and the source is reported as failed — preventing a misconfigured
 * or compromised plugin from manufacturing pre/post-action prompt-shaping
 * signals.
 */
export async function readSignalSources(
  sources: readonly SignalSource[],
  timeoutMs: number,
  onError: (error: unknown) => void,
): Promise<SignalReadResult> {
  if (sources.length === 0) return { signals: [], failedSources: [] };
  type SensorSignal = Extract<UserSignal, { kind: "sensor" }>;
  type ReadOutcome = { readonly name: string; readonly value: SensorSignal | null };
  const tasks = sources.map(async (source): Promise<ReadOutcome> => {
    try {
      const value = await withTimeout(source.read(), timeoutMs, source.name);
      if (value.kind !== "sensor") {
        onError(
          new Error(
            `SignalSource '${source.name}' returned non-sensor kind '${value.kind}' — rejected at boundary`,
          ),
        );
        return { name: source.name, value: null };
      }
      return { name: source.name, value };
    } catch (e: unknown) {
      onError(e);
      return { name: source.name, value: null };
    }
  });
  const settled = await Promise.allSettled(tasks);
  const signals: SourceSignal[] = [];
  const failed: string[] = [];
  for (const [idx, r] of settled.entries()) {
    if (r.status === "fulfilled") {
      if (r.value.value !== null) signals.push({ sourceName: r.value.name, signal: r.value.value });
      else failed.push(r.value.name);
    } else {
      const fallback = sources[idx]?.name ?? "<unknown>";
      failed.push(fallback);
      onError(r.reason);
    }
  }
  return { signals, failedSources: failed };
}

function withTimeout<T>(value: T | Promise<T>, ms: number, sourceName: string): Promise<T> {
  if (!(value instanceof Promise)) return Promise.resolve(value);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`SignalSource '${sourceName}' timed out after ${String(ms)}ms`));
    }, ms);
    value.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
