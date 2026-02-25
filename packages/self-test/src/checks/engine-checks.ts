/**
 * Engine adapter contract checks.
 *
 * Verifies that the adapter has a valid engineId, stream() is callable,
 * stream yields a done event with valid output, and dispose completes cleanly.
 */

import type { EngineAdapter, EngineEvent, EngineInput } from "@koi/core";
import { collectEvents, isAdapterFactory, runCheck, skipCheck } from "../check-runner.js";
import type { CheckResult } from "../types.js";

const PING_INPUT: EngineInput = { kind: "text", text: "ping" };

export async function runEngineChecks(
  adapterOrFactory: EngineAdapter | (() => EngineAdapter | Promise<EngineAdapter>),
  checkTimeoutMs: number,
): Promise<readonly CheckResult[]> {
  const results: CheckResult[] = [];
  const isFactory = isAdapterFactory(adapterOrFactory);

  // let: assigned inside runCheck closure, read after for subsequent checks
  let adapter: EngineAdapter | undefined;
  const resolveResult = await runCheck(
    "engine: adapter resolves",
    "engine",
    async () => {
      adapter = isFactory ? await adapterOrFactory() : adapterOrFactory;
    },
    checkTimeoutMs,
  );
  results.push(resolveResult);

  if (resolveResult.status !== "pass" || adapter === undefined) {
    results.push(skipCheck("engine: engineId is valid", "engine", "Adapter resolution failed"));
    results.push(skipCheck("engine: stream is callable", "engine", "Adapter resolution failed"));
    results.push(
      skipCheck("engine: stream yields done event", "engine", "Adapter resolution failed"),
    );
    results.push(skipCheck("engine: done output is valid", "engine", "Adapter resolution failed"));
    if (isFactory) {
      results.push(skipCheck("engine: dispose completes", "engine", "Adapter resolution failed"));
    }
    return results;
  }

  // Capture adapter in a const for closure safety
  const resolvedAdapter = adapter;

  // engineId is a non-empty string
  results.push(
    await runCheck(
      "engine: engineId is valid",
      "engine",
      () => {
        if (typeof resolvedAdapter.engineId !== "string" || resolvedAdapter.engineId.length === 0) {
          throw new Error("engineId must be a non-empty string");
        }
      },
      checkTimeoutMs,
    ),
  );

  // stream is a function
  results.push(
    await runCheck(
      "engine: stream is callable",
      "engine",
      () => {
        if (typeof resolvedAdapter.stream !== "function") {
          throw new Error("stream must be a function");
        }
      },
      checkTimeoutMs,
    ),
  );

  // let: populated inside stream check closure, read in output validation check
  let events: readonly EngineEvent[] = [];
  const streamResult = await runCheck(
    "engine: stream yields done event",
    "engine",
    async (signal) => {
      const input: EngineInput = { ...PING_INPUT, signal };
      events = await collectEvents(resolvedAdapter.stream(input));
      const doneEvent = events.find((e) => e.kind === "done");
      if (doneEvent === undefined) {
        throw new Error("Stream did not yield a done event");
      }
    },
    checkTimeoutMs,
  );
  results.push(streamResult);

  // done output structure is valid
  if (streamResult.status === "pass") {
    results.push(
      await runCheck(
        "engine: done output is valid",
        "engine",
        () => {
          const doneEvent = events.find(
            (e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done",
          );
          if (doneEvent === undefined) {
            throw new Error("No done event found");
          }
          const { output } = doneEvent;
          if (!Array.isArray(output.content)) {
            throw new Error("output.content must be an array");
          }
          const validReasons = new Set(["completed", "max_turns", "interrupted", "error"]);
          if (!validReasons.has(output.stopReason)) {
            throw new Error(`Invalid stopReason: ${output.stopReason}`);
          }
          if (typeof output.metrics.totalTokens !== "number") {
            throw new Error("output.metrics.totalTokens must be a number");
          }
          if (typeof output.metrics.durationMs !== "number") {
            throw new Error("output.metrics.durationMs must be a number");
          }
        },
        checkTimeoutMs,
      ),
    );
  } else {
    results.push(skipCheck("engine: done output is valid", "engine", "Stream check failed"));
  }

  // dispose completes (only if factory — self-test owns lifecycle)
  if (isFactory) {
    results.push(
      await runCheck(
        "engine: dispose completes",
        "engine",
        async () => {
          if (resolvedAdapter.dispose !== undefined) {
            await resolvedAdapter.dispose();
          }
        },
        checkTimeoutMs,
      ),
    );
  }

  return results;
}
