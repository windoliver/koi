/**
 * Parallel SignalSource reader with per-source timeout.
 *
 * Reads all configured signal sources in parallel using Promise.allSettled().
 * Each source gets an individual timeout to prevent slow sources from blocking.
 * Failed or timed-out sources are skipped — preferences still work.
 */

import type { SignalSource, UserSignal } from "@koi/core/user-model";

export interface SignalReadResult {
  readonly signals: readonly UserSignal[];
  readonly errors: readonly SignalReadError[];
}

export interface SignalReadError {
  readonly source: string;
  readonly reason: "timeout" | "error" | "malformed";
  readonly detail?: unknown;
}

function isValidSignal(value: unknown): value is UserSignal {
  if (value === null || value === undefined || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.kind === "pre_action" || v.kind === "post_action" || v.kind === "sensor";
}

function createTimeoutPromise(ms: number): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    setTimeout(() => {
      reject(new Error(`Signal source timed out after ${String(ms)}ms`));
    }, ms);
  });
}

export async function readSignalSources(
  sources: readonly SignalSource[],
  timeoutMs: number,
): Promise<SignalReadResult> {
  if (sources.length === 0) {
    return { signals: [], errors: [] };
  }

  const tasks = sources.map(
    async (
      source,
    ): Promise<
      | { readonly ok: true; readonly signal: UserSignal }
      | { readonly ok: false; readonly error: SignalReadError }
    > => {
      try {
        const result = await Promise.race([
          Promise.resolve(source.read()),
          createTimeoutPromise(timeoutMs),
        ]);

        if (!isValidSignal(result)) {
          return {
            ok: false,
            error: { source: source.name, reason: "malformed", detail: result },
          };
        }

        return { ok: true, signal: result };
      } catch (e: unknown) {
        const isTimeout = e instanceof Error && e.message.includes("timed out");
        return {
          ok: false,
          error: {
            source: source.name,
            reason: isTimeout ? "timeout" : "error",
            detail: e,
          },
        };
      }
    },
  );

  const settled = await Promise.all(tasks);

  const signals: UserSignal[] = [];
  const errors: SignalReadError[] = [];

  for (const result of settled) {
    if (result.ok) {
      signals.push(result.signal);
    } else {
      errors.push(result.error);
    }
  }

  return { signals, errors };
}
