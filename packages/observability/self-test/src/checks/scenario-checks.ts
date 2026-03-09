/**
 * E2E scenario checks.
 *
 * Streams scenario input through the adapter, verifies the stream completes
 * with a done event, matches expected patterns, and runs custom assertions.
 */

import type { EngineAdapter, EngineInput } from "@koi/core";
import {
  collectEvents,
  extractText,
  isAdapterFactory,
  runCheck,
  skipCheck,
} from "../check-runner.js";
import type { CheckResult, SelfTestScenario } from "../types.js";

/** Escape regex metacharacters so a string is matched literally. */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function runScenarioChecks(
  adapterOrFactory: EngineAdapter | (() => EngineAdapter | Promise<EngineAdapter>),
  scenarios: readonly SelfTestScenario[],
  checkTimeoutMs: number,
): Promise<readonly CheckResult[]> {
  const results: CheckResult[] = [];

  if (scenarios.length === 0) {
    results.push(
      skipCheck("scenarios: no scenarios to check", "scenarios", "No scenarios provided"),
    );
    return results;
  }

  const isFactory = isAdapterFactory(adapterOrFactory);

  for (const scenario of scenarios) {
    results.push(
      await runCheck(
        `scenario[${scenario.name}]: completes`,
        "scenarios",
        async (signal) => {
          // Resolve adapter: factory = fresh per scenario, instance = shared
          const adapter = isFactory ? await adapterOrFactory() : adapterOrFactory;

          try {
            const input: EngineInput = { ...scenario.input, signal };
            const events = await collectEvents(adapter.stream(input));

            // Verify done event exists
            const doneEvent = events.find((e) => e.kind === "done");
            if (doneEvent === undefined) {
              throw new Error("Stream did not yield a done event");
            }

            // Check expected pattern against text_delta output
            if (scenario.expectedPattern !== undefined) {
              const text = extractText(events);
              const pattern =
                scenario.expectedPattern instanceof RegExp
                  ? scenario.expectedPattern
                  : new RegExp(escapeRegExp(scenario.expectedPattern));
              if (!pattern.test(text)) {
                throw new Error(
                  `Output text did not match pattern ${String(scenario.expectedPattern)}. Got: "${text}"`,
                );
              }
            }

            // Run custom assertion
            if (scenario.assert !== undefined) {
              await scenario.assert(events);
            }
          } finally {
            // Dispose factory-created adapters
            if (isFactory && adapter.dispose !== undefined) {
              await adapter.dispose();
            }
          }
        },
        checkTimeoutMs,
      ),
    );
  }

  return results;
}
