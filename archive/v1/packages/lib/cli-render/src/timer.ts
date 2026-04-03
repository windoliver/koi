/**
 * Phase timing instrumentation for CLI commands.
 *
 * Records elapsed time for named phases and prints a summary.
 * When disabled, all operations are no-ops (the wrapped function still executes).
 */

export interface TimingEntry {
  readonly label: string;
  readonly durationMs: number;
}

export interface Timer {
  /** Time an async operation and record its duration under `label`. */
  readonly time: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
  /** Print all recorded timings to the given stream. */
  readonly print: (stream?: NodeJS.WritableStream) => void;
  /** Get all recorded entries (for testing). */
  readonly entries: () => readonly TimingEntry[];
}

export function createTimer(enabled: boolean): Timer {
  const recorded: TimingEntry[] = [];
  const startTime = performance.now();

  return {
    async time<T>(label: string, fn: () => Promise<T>): Promise<T> {
      if (!enabled) return fn();
      const start = performance.now();
      const result = await fn();
      recorded.push({
        label,
        durationMs: Math.round(performance.now() - start),
      });
      return result;
    },
    print(stream: NodeJS.WritableStream = process.stderr): void {
      if (!enabled) return;
      stream.write("\n");
      for (const entry of recorded) {
        const padded = entry.label.padEnd(14);
        stream.write(`[timing] ${padded} ${String(entry.durationMs)}ms\n`);
      }
      const total = Math.round(performance.now() - startTime);
      stream.write(`[timing] ${"total".padEnd(14)} ${String(total)}ms\n`);
    },
    entries(): readonly TimingEntry[] {
      return recorded;
    },
  };
}
