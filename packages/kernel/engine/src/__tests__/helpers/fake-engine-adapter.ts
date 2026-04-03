/**
 * FakeEngineAdapter — controllable test double for engine adapter.
 *
 * Pre-scripted event sequences let tests control tool boundaries and turn
 * structure. Records inject() calls for assertion.
 *
 * Inlined from @koi/test-utils-mocks for v2 scaffold independence.
 */

import type { EngineAdapter, EngineEvent, EngineInput, InboundMessage } from "@koi/core";

export interface FakeEngineAdapterConfig {
  /** Pre-scripted turns. Each inner array is the events for one turn. */
  readonly turns: readonly (readonly EngineEvent[])[];
}

export interface FakeEngineAdapterResult {
  readonly adapter: EngineAdapter;
  /** Messages that were passed to inject(). */
  readonly injectedMessages: readonly InboundMessage[];
}

export function createFakeEngineAdapter(config: FakeEngineAdapterConfig): FakeEngineAdapterResult {
  const injected: InboundMessage[] = [];

  const adapter: EngineAdapter = {
    engineId: "fake-engine",
    capabilities: { text: true, images: false, files: false, audio: false },

    stream(_input: EngineInput): AsyncIterable<EngineEvent> {
      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<EngineEvent> {
          for (let turnIndex = 0; turnIndex < config.turns.length; turnIndex++) {
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
              stopReason: "completed",
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
