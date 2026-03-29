/**
 * EngineAdapter → SpawnFn wrapper.
 *
 * Runs adapter.stream(), collects text_delta events, and returns a
 * SpawnResult. Handles abort signals and error mapping.
 */

import type { EngineAdapter, KoiError, SpawnFn, SpawnRequest, SpawnResult } from "@koi/core";

/**
 * Wrap an EngineAdapter as a SpawnFn.
 *
 * Sends `request.description` as text input, collects `text_delta` events,
 * and returns the concatenated output on completion.
 */
export function createAdapterSpawnFn(adapter: EngineAdapter): SpawnFn {
  return async (request: SpawnRequest): Promise<SpawnResult> => {
    const chunks: string[] = [];

    try {
      for await (const event of adapter.stream({
        kind: "text",
        text: request.description,
        signal: request.signal,
      })) {
        if (event.kind === "text_delta") {
          chunks.push(event.delta);
        }

        if (event.kind === "done") {
          if (event.output.stopReason === "completed") {
            return { ok: true, output: chunks.join("") };
          }

          const error: KoiError = {
            code: "EXTERNAL",
            message: `Engine stopped with reason: ${event.output.stopReason}`,
            retryable: event.output.stopReason === "interrupted",
          };
          return { ok: false, error };
        }
      }

      // Stream ended without a done event — treat as error
      return {
        ok: false,
        error: {
          code: "EXTERNAL",
          message: "Engine stream ended without done event",
          retryable: false,
        },
      };
    } catch (e: unknown) {
      // Abort signal fired mid-stream
      if (e instanceof DOMException && e.name === "AbortError") {
        return {
          ok: false,
          error: {
            code: "TIMEOUT",
            message: "Spawn aborted by signal",
            retryable: false,
          },
        };
      }

      const message = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        error: {
          code: "EXTERNAL",
          message: `Engine adapter error: ${message}`,
          retryable: false,
          cause: e,
        },
      };
    }
  };
}
