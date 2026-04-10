/**
 * FakeEngine — controllable EngineAdapter double.
 *
 * Takes pre-scripted turn bodies and emits them wrapped with the engine's
 * standard control flow: `turn_start` / body / `turn_end` per turn, followed
 * by a terminal `done` event.
 *
 * ## Why `TurnBodyEvent`
 *
 * `turn_start`, `turn_end`, and `done` are emitted by the helper itself.
 * Scripting those inside the turn body would cause duplicate control flow
 * and nonsensical transcripts, so they are compile-time excluded from the
 * accepted event type. A runtime guard is kept as defense-in-depth.
 */

import type {
  EngineAdapter,
  EngineEvent,
  EngineInput,
  EngineStopReason,
  InboundMessage,
} from "@koi/core";

/** Engine events permitted inside a scripted turn body. */
export type TurnBodyEvent = Exclude<
  EngineEvent,
  { readonly kind: "turn_start" | "turn_end" | "done" }
>;

export interface FakeEngineConfig {
  /** Pre-scripted turns. Each inner array is the body of one turn. */
  readonly turns: readonly (readonly TurnBodyEvent[])[];
  readonly engineId?: string;
  readonly finalStopReason?: EngineStopReason;
}

export interface FakeEngineResult {
  readonly adapter: EngineAdapter;
  /** Messages that were passed to inject(). */
  readonly injectedMessages: readonly InboundMessage[];
}

const FORBIDDEN_BODY_KINDS: ReadonlySet<string> = new Set(["turn_start", "turn_end", "done"]);

export function createFakeEngine(config: FakeEngineConfig): FakeEngineResult {
  // Runtime defense-in-depth: even if a caller casts around the type,
  // we catch forbidden control events inside a turn body.
  for (let t = 0; t < config.turns.length; t += 1) {
    const body = config.turns[t];
    if (body === undefined) continue;
    for (const event of body) {
      if (FORBIDDEN_BODY_KINDS.has(event.kind)) {
        throw new Error(
          `createFakeEngine: turn ${t} body contains forbidden control event "${event.kind}". ` +
            `turn_start/turn_end/done are emitted automatically by the helper.`,
        );
      }
    }
  }

  const injected: InboundMessage[] = [];
  const engineId = config.engineId ?? "fake-engine";
  const finalStopReason: EngineStopReason = config.finalStopReason ?? "completed";

  const adapter: EngineAdapter = {
    engineId,
    capabilities: { text: true, images: false, files: false, audio: false },

    stream(_input: EngineInput): AsyncIterable<EngineEvent> {
      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<EngineEvent> {
          for (let turnIndex = 0; turnIndex < config.turns.length; turnIndex += 1) {
            const turnEvents = config.turns[turnIndex];
            if (turnEvents === undefined) continue;

            yield { kind: "turn_start", turnIndex };
            for (const event of turnEvents) {
              yield event;
            }
            yield { kind: "turn_end", turnIndex };
          }

          yield {
            kind: "done",
            output: {
              content: [],
              stopReason: finalStopReason,
              metrics: {
                totalTokens: 0,
                inputTokens: 0,
                outputTokens: 0,
                turns: config.turns.length,
                durationMs: 0,
              },
            },
          };
        },
      };
    },

    inject(message: InboundMessage): void {
      injected.push(message);
    },
  };

  return { adapter, injectedMessages: injected };
}
