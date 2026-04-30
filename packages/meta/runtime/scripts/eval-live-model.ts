/**
 * Live-model E2E for @koi/eval — drives runEval against a real
 * OpenRouter model via a minimal direct-adapter bridge.
 *
 *   OPENROUTER_API_KEY=... bun run packages/meta/runtime/scripts/eval-live-model.ts
 *
 * Mock-only corner cases live in
 * packages/lib/eval/scripts/e2e-corner-cases.ts; this script complements
 * those by exercising the runner + grader + cancellation paths against
 * real network traffic.
 */
import type { EngineEvent } from "@koi/core";
import type { AgentHandle, EvalTask } from "@koi/eval";
import { exactMatch, runEval } from "@koi/eval";
import { createOpenAICompatAdapter } from "@koi/model-openai-compat";

const apiKey = process.env.OPENROUTER_API_KEY;
if (apiKey === undefined || apiKey.length === 0) {
  console.error("OPENROUTER_API_KEY missing");
  process.exit(2);
}

const adapter = createOpenAICompatAdapter({
  apiKey,
  baseUrl: "https://openrouter.ai/api/v1",
  model: "google/gemini-2.0-flash-001",
  retry: { maxRetries: 1 },
});

// Direct model bridge: skip the full agent loop (no tools needed for grader
// E2E) and just call the model adapter, then synthesize an EngineEvent
// transcript. This is the smallest live-model surface that exercises
// runEval + grader against a real network response.
const MODEL = "google/gemini-2.0-flash-001";
const buildHandle = (): AgentHandle => ({
  stream: (input): AsyncIterable<EngineEvent> => ({
    [Symbol.asyncIterator]: async function* () {
      const text = input.kind === "text" ? input.text : "";
      const r = await adapter.complete({
        messages: [{ senderId: "user", timestamp: Date.now(), content: [{ kind: "text", text }] }],
        model: MODEL,
      });
      yield { kind: "text_delta", delta: r.content };
      yield {
        kind: "done",
        output: {
          content: [{ kind: "text", text: r.content }],
          stopReason: "completed",
          metrics: {
            totalTokens: (r.usage?.inputTokens ?? 0) + (r.usage?.outputTokens ?? 0),
            inputTokens: r.usage?.inputTokens ?? 0,
            outputTokens: r.usage?.outputTokens ?? 0,
            turns: 1,
            durationMs: 0,
          },
        },
      };
    },
  }),
});

let pass = 0;
let fail = 0;
const log = (name: string, ok: boolean, detail = ""): void => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

// Case 1 — exact text match against a deterministic prompt
{
  const tasks: readonly EvalTask[] = [
    {
      id: "exact",
      name: "exact",
      input: {
        kind: "text",
        text: "Reply with exactly the single word: hello (lowercase, no punctuation, no other text)",
      },
      expected: { kind: "text", pattern: "hello" },
      graders: [exactMatch()],
      timeoutMs: 30_000,
    },
  ];
  const r = await runEval({
    name: "live",
    tasks,
    agentFactory: buildHandle,
    idGen: () => `live-${Date.now()}`,
  });
  log(
    "live model: exact match grader",
    r.trials[0]?.status === "pass",
    r.trials[0]?.scores[0]?.reasoning ?? r.trials[0]?.error,
  );
  console.log(
    "  raw response:",
    JSON.stringify(r.trials[0]?.transcript.find((e) => e.kind === "done")),
  );
}

// Case 2 — regex pattern match across model variability
{
  const r = await runEval({
    name: "live",
    tasks: [
      {
        id: "regex",
        name: "regex",
        input: { kind: "text", text: "Name a primary color." },
        expected: { kind: "text", pattern: /(red|blue|yellow)/i },
        graders: [exactMatch()],
        timeoutMs: 30_000,
      },
    ],
    agentFactory: buildHandle,
    idGen: () => `regex-${Date.now()}`,
  });
  log(
    "live model: regex pattern match",
    r.trials[0]?.status === "pass",
    r.trials[0]?.scores[0]?.reasoning ?? r.trials[0]?.error,
  );
}

// Case 3 — pre-aborted upstream signal short-circuits before network call
{
  const ctrl = new AbortController();
  ctrl.abort(new Error("preaborted"));
  const r = await runEval({
    name: "live",
    tasks: [
      {
        id: "preab",
        name: "preab",
        input: { kind: "text", text: "anything", signal: ctrl.signal } as EvalTask["input"],
        expected: { kind: "text", pattern: "x" },
        graders: [exactMatch()],
        timeoutMs: 30_000,
      },
    ],
    agentFactory: buildHandle,
    idGen: () => `preab-${Date.now()}`,
  });
  log(
    "live model: pre-aborted signal → confirmed (no API call)",
    r.trials[0]?.cancellation === "confirmed" && r.aborted === undefined,
    r.trials[0]?.cancellation,
  );
}

// Case 4 — short timeout against a real model: cancellation classified
{
  const r = await runEval({
    name: "live",
    tasks: [
      {
        id: "timeout",
        name: "timeout",
        input: { kind: "text", text: "Write a 500-word essay about apples." },
        graders: [exactMatch()],
        timeoutMs: 1, // immediate timeout
      },
    ],
    agentFactory: buildHandle,
    disposeTimeoutMs: 500,
    idGen: () => `to-${Date.now()}`,
  });
  log(
    "live model: short timeout has classified cancellation",
    r.trials[0]?.cancellation !== "n/a",
    `${r.trials[0]?.cancellation} (status=${r.trials[0]?.status})`,
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
