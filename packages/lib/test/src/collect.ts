/**
 * Pure helpers for draining and inspecting EngineEvent streams.
 */

import type { EngineEvent, EngineOutput } from "@koi/core";

/** Drain an async iterable of EngineEvents into a plain array. */
export async function collectEvents(
  stream: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const event of stream) {
    out.push(event);
  }
  return out;
}

/** Concatenate the delta of every text_delta event in order. */
export function collectText(events: readonly EngineEvent[]): string {
  let out = "";
  for (const event of events) {
    if (event.kind === "text_delta") {
      out += event.delta;
    }
  }
  return out;
}

/** Extract the `toolName` from every tool_call_start event in order. */
export function collectToolNames(events: readonly EngineEvent[]): readonly string[] {
  const names: string[] = [];
  for (const event of events) {
    if (event.kind === "tool_call_start") {
      names.push(event.toolName);
    }
  }
  return names;
}

/** Return the EngineOutput from the first `done` event, if any. */
export function collectOutput(events: readonly EngineEvent[]): EngineOutput | undefined {
  for (const event of events) {
    if (event.kind === "done") {
      return event.output;
    }
  }
  return undefined;
}

/** Return the inputTokens/outputTokens from the done event metrics, if any. */
export function collectUsage(
  events: readonly EngineEvent[],
): { readonly inputTokens: number; readonly outputTokens: number } | undefined {
  const output = collectOutput(events);
  if (output === undefined) return undefined;
  return {
    inputTokens: output.metrics.inputTokens,
    outputTokens: output.metrics.outputTokens,
  };
}

/** Filter events by discriminant `kind`. */
export function filterByKind<K extends EngineEvent["kind"]>(
  events: readonly EngineEvent[],
  kind: K,
): readonly Extract<EngineEvent, { readonly kind: K }>[] {
  const out: Extract<EngineEvent, { readonly kind: K }>[] = [];
  for (const event of events) {
    if (event.kind === kind) {
      out.push(event as Extract<EngineEvent, { readonly kind: K }>);
    }
  }
  return out;
}
