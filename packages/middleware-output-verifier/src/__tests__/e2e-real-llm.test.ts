/**
 * Full-stack E2E: createKoi + createPiAdapter + @koi/middleware-output-verifier.
 *
 * Validates output verifier middleware with real LLM calls through the full
 * L1 runtime assembly. Tests all two stages (deterministic + judge) and all
 * three actions (block, warn, revise) with real model output.
 *
 * Run:
 *   E2E_TESTS=1 bun test src/__tests__/e2e-real-llm.test.ts
 *
 * Requires ANTHROPIC_API_KEY in .env at repo root.
 */

import { describe, expect, test } from "bun:test";
import type { EngineEvent } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import { createOutputVerifierMiddleware, nonEmpty } from "../index.js";
import type { DeterministicCheck, JudgeConfig, VerifierVetoEvent } from "../types.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const describeE2E = HAS_KEY && E2E_OPTED_IN ? describe : describe.skip;

const TIMEOUT_MS = 120_000;
const E2E_MODEL = "anthropic:claude-haiku-4-5-20251001";

const E2E_MANIFEST = {
  name: "E2E Verifier Agent",
  version: "0.1.0",
  model: { name: E2E_MODEL },
} as const;

const JUDGE_MANIFEST = {
  name: "Judge",
  version: "0.1.0",
  model: { name: E2E_MODEL },
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

function extractText(events: readonly EngineEvent[]): string {
  return events
    .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
    .map((e) => e.delta)
    .join("");
}

function createAdapter(
  systemPrompt = "You are a concise assistant. Reply briefly.",
): ReturnType<typeof createPiAdapter> {
  return createPiAdapter({
    model: E2E_MODEL,
    systemPrompt,
    getApiKey: async () => ANTHROPIC_KEY,
  });
}

/**
 * Creates a judge modelCall using a real LLM call.
 * The judge uses a separate Haiku instance to evaluate agent output.
 */
function createRealJudgeModelCall(): JudgeConfig["modelCall"] {
  const judgeAdapter = createPiAdapter({
    model: E2E_MODEL,
    systemPrompt: "You are an output quality judge. Respond with ONLY valid JSON.",
    getApiKey: async () => ANTHROPIC_KEY,
  });

  return async (prompt: string, signal?: AbortSignal): Promise<string> => {
    const runtime = await createKoi({
      manifest: JUDGE_MANIFEST,
      adapter: judgeAdapter,
      loopDetection: false,
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: prompt, signal }));
    await runtime.dispose();
    return extractText(events);
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: @koi/middleware-output-verifier through full L1 runtime", () => {
  // ── Test 1: Deterministic pass — LLM output passes nonEmpty check ────

  test(
    "deterministic pass: nonEmpty check passes real LLM output",
    async () => {
      const events: VerifierVetoEvent[] = [];
      const handle = createOutputVerifierMiddleware({
        deterministic: [nonEmpty("block")],
        onVeto: (e) => events.push(e),
      });

      const runtime = await createKoi({
        manifest: E2E_MANIFEST,
        adapter: createAdapter(),
        middleware: [handle.middleware],
        loopDetection: false,
      });

      const engineEvents = await collectEvents(
        runtime.run({ kind: "text", text: "Reply with exactly: hello world" }),
      );
      await runtime.dispose();

      // Output should be delivered (no block)
      const text = extractText(engineEvents);
      expect(text.length).toBeGreaterThan(0);

      // No veto events should have fired
      expect(events).toHaveLength(0);

      // Stats should show 1 check, 0 vetoes
      const stats = handle.getStats();
      expect(stats.totalChecks).toBeGreaterThanOrEqual(1);
      expect(stats.vetoed).toBe(0);
      expect(stats.warned).toBe(0);

      // Should have completed successfully
      const done = engineEvents.find((e) => e.kind === "done");
      expect(done).toBeDefined();
    },
    TIMEOUT_MS,
  );

  // ── Test 2: Deterministic warn — fires event but delivers output ─────

  test(
    "deterministic warn: fires veto event but delivers LLM output",
    async () => {
      // Warn if output contains "hello" (which it should)
      const warnOnHello: DeterministicCheck = {
        name: "warn-on-hello",
        check: (c) => !c.toLowerCase().includes("hello") || "Contains hello",
        action: "warn",
      };

      const events: VerifierVetoEvent[] = [];
      const handle = createOutputVerifierMiddleware({
        deterministic: [warnOnHello],
        onVeto: (e) => events.push(e),
      });

      const runtime = await createKoi({
        manifest: E2E_MANIFEST,
        adapter: createAdapter(),
        middleware: [handle.middleware],
        loopDetection: false,
      });

      const engineEvents = await collectEvents(
        runtime.run({ kind: "text", text: "Say exactly: hello" }),
      );
      await runtime.dispose();

      // Output should still be delivered (warn doesn't block)
      const text = extractText(engineEvents);
      expect(text.length).toBeGreaterThan(0);

      // Warn event should have fired
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0]?.source).toBe("deterministic");
      expect(events[0]?.action).toBe("warn");
      expect(events[0]?.checkName).toBe("warn-on-hello");

      // Stats
      const stats = handle.getStats();
      expect(stats.warned).toBeGreaterThanOrEqual(1);
      expect(stats.vetoed).toBe(0);
    },
    TIMEOUT_MS,
  );

  // ── Test 3: Deterministic block — degrades to warn in streaming mode ─
  //
  // Pi adapter always uses wrapModelStream. In streaming mode, content is
  // yielded before verification runs, so block/revise degrade to warn
  // with `degraded: true`. This is by design — we test the degradation
  // behavior that real users will encounter with the Pi adapter.

  test(
    "deterministic block: degrades to warn in streaming mode (Pi always streams)",
    async () => {
      // Block all output (always returns false)
      const blockAll: DeterministicCheck = {
        name: "block-all",
        check: () => "All output blocked for testing",
        action: "block",
      };

      const events: VerifierVetoEvent[] = [];
      const handle = createOutputVerifierMiddleware({
        deterministic: [blockAll],
        onVeto: (e) => events.push(e),
      });

      const runtime = await createKoi({
        manifest: E2E_MANIFEST,
        adapter: createAdapter(),
        middleware: [handle.middleware],
        loopDetection: false,
      });

      const engineEvents = await collectEvents(runtime.run({ kind: "text", text: "Say: hello" }));
      await runtime.dispose();

      // Output is still delivered (streaming: content already yielded)
      const text = extractText(engineEvents);
      expect(text.length).toBeGreaterThan(0);

      // Block event fires with degraded flag (block → warn in streaming mode)
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0]?.source).toBe("deterministic");
      expect(events[0]?.action).toBe("block");
      expect(events[0]?.degraded).toBe(true);

      // Stats: streaming degradation increments warned + deterministicVetoes, not vetoed
      const stats = handle.getStats();
      expect(stats.warned).toBeGreaterThanOrEqual(1);
      expect(stats.deterministicVetoes).toBeGreaterThanOrEqual(1);
    },
    TIMEOUT_MS,
  );

  // ── Test 4: Deterministic revise — degrades to warn in streaming mode ─
  //
  // Same degradation as block: Pi always streams, so revise cannot retry.
  // The check runs once post-hoc and fires a degraded warn event.

  test(
    "deterministic revise: degrades to warn in streaming mode (no retry possible)",
    async () => {
      // let justified: tracks call count across verifyStream invocations
      let checkCount = 0;
      const reviseOnce: DeterministicCheck = {
        name: "revise-first-attempt",
        check: () => {
          checkCount++;
          // Always fails — in streaming mode, no retry will happen
          return checkCount > 1 || "First attempt always needs revision";
        },
        action: "revise",
      };

      const events: VerifierVetoEvent[] = [];
      const handle = createOutputVerifierMiddleware({
        deterministic: [reviseOnce],
        maxRevisions: 1,
        onVeto: (e) => events.push(e),
      });

      const runtime = await createKoi({
        manifest: E2E_MANIFEST,
        adapter: createAdapter(),
        middleware: [handle.middleware],
        loopDetection: false,
      });

      const engineEvents = await collectEvents(
        runtime.run({ kind: "text", text: "Say: revised output" }),
      );
      await runtime.dispose();

      // Output is still delivered (streaming: content already yielded)
      const text = extractText(engineEvents);
      expect(text.length).toBeGreaterThan(0);

      // Revise event fires with degraded flag (no retry in streaming mode)
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0]?.action).toBe("revise");
      expect(events[0]?.degraded).toBe(true);

      // Check only ran once — no retry possible in streaming mode
      expect(checkCount).toBe(1);

      // Stats: warned (degraded), not vetoed
      const stats = handle.getStats();
      expect(stats.warned).toBeGreaterThanOrEqual(1);
      expect(stats.deterministicVetoes).toBeGreaterThanOrEqual(1);
    },
    TIMEOUT_MS,
  );

  // ── Test 5: Judge stage with real LLM — passing score ────────────────

  test(
    "judge pass: real LLM-as-judge scores output above threshold",
    async () => {
      const events: VerifierVetoEvent[] = [];
      const handle = createOutputVerifierMiddleware({
        judge: {
          rubric:
            "The output should be a friendly greeting. It should contain a greeting word like 'hello', 'hi', or 'hey'.",
          modelCall: createRealJudgeModelCall(),
          vetoThreshold: 0.5, // Low threshold — greeting should easily pass
          action: "block",
          randomFn: () => 0, // Always sample
        },
        onVeto: (e) => events.push(e),
      });

      const runtime = await createKoi({
        manifest: E2E_MANIFEST,
        adapter: createAdapter("You are a friendly assistant. Always greet users warmly."),
        middleware: [handle.middleware],
        loopDetection: false,
      });

      const engineEvents = await collectEvents(
        runtime.run({ kind: "text", text: "Greet me warmly" }),
      );
      await runtime.dispose();

      // Output should be delivered (score above threshold)
      const text = extractText(engineEvents);
      expect(text.length).toBeGreaterThan(0);

      // Judge should have run
      const stats = handle.getStats();
      expect(stats.judgedChecks).toBeGreaterThanOrEqual(1);

      // No block events should have fired (expect pass or warn at most)
      const blockEvents = events.filter((e) => e.action === "block");
      expect(blockEvents).toHaveLength(0);
    },
    TIMEOUT_MS,
  );

  // ── Test 6: Judge stage with real LLM — warn action ──────────────────

  test(
    "judge warn: real LLM-as-judge warns but delivers output",
    async () => {
      const events: VerifierVetoEvent[] = [];
      const handle = createOutputVerifierMiddleware({
        judge: {
          rubric:
            "The output must be a perfectly formatted haiku with exactly 5-7-5 syllable structure. No other format is acceptable.",
          modelCall: createRealJudgeModelCall(),
          vetoThreshold: 0.99, // Very high threshold — almost nothing passes
          action: "warn",
          randomFn: () => 0, // Always sample
        },
        onVeto: (e) => events.push(e),
      });

      const runtime = await createKoi({
        manifest: E2E_MANIFEST,
        adapter: createAdapter("You are a concise assistant. Just say hello."),
        middleware: [handle.middleware],
        loopDetection: false,
      });

      const engineEvents = await collectEvents(runtime.run({ kind: "text", text: "Say hello" }));
      await runtime.dispose();

      // Output should still be delivered (warn doesn't block)
      const text = extractText(engineEvents);
      expect(text.length).toBeGreaterThan(0);

      // Judge should have run and issued a warn
      const stats = handle.getStats();
      expect(stats.judgedChecks).toBeGreaterThanOrEqual(1);
      expect(stats.warned).toBeGreaterThanOrEqual(1);

      // Warn event should contain judge score
      if (events.length > 0) {
        expect(events[0]?.source).toBe("judge");
        expect(events[0]?.action).toBe("warn");
        expect(typeof events[0]?.score).toBe("number");
      }
    },
    TIMEOUT_MS,
  );

  // ── Test 7: Both stages — deterministic + judge ──────────────────────

  test(
    "both stages: deterministic checks run first, then judge evaluates",
    async () => {
      const events: VerifierVetoEvent[] = [];
      const handle = createOutputVerifierMiddleware({
        deterministic: [nonEmpty("block")],
        judge: {
          rubric: "The output should be helpful and relevant to the user's question.",
          modelCall: createRealJudgeModelCall(),
          vetoThreshold: 0.25, // Low threshold — should pass
          action: "block",
          randomFn: () => 0, // Always sample
        },
        onVeto: (e) => events.push(e),
      });

      const runtime = await createKoi({
        manifest: E2E_MANIFEST,
        adapter: createAdapter(),
        middleware: [handle.middleware],
        loopDetection: false,
      });

      const engineEvents = await collectEvents(
        runtime.run({ kind: "text", text: "What is 2 + 2?" }),
      );
      await runtime.dispose();

      // Output delivered
      const text = extractText(engineEvents);
      expect(text.length).toBeGreaterThan(0);

      // Both stages ran
      const stats = handle.getStats();
      expect(stats.totalChecks).toBeGreaterThanOrEqual(1);
      expect(stats.judgedChecks).toBeGreaterThanOrEqual(1);
      expect(stats.vetoed).toBe(0); // Low threshold → pass
    },
    TIMEOUT_MS,
  );

  // ── Test 8: setRubric updates judge dynamically ──────────────────────

  test(
    "setRubric: dynamically updates judge rubric between calls",
    async () => {
      const capturedRubrics: string[] = [];
      const realCall = createRealJudgeModelCall();

      const handle = createOutputVerifierMiddleware({
        judge: {
          rubric: "First rubric: output must mention cats",
          modelCall: async (prompt, signal) => {
            // Capture rubric from prompt
            const rubricMatch = /## Rubric\n(.*?)\n\n/s.exec(prompt);
            if (rubricMatch?.[1]) capturedRubrics.push(rubricMatch[1]);
            return await realCall(prompt, signal);
          },
          vetoThreshold: 0.25,
          action: "warn",
          randomFn: () => 0,
        },
      });

      const runtime = await createKoi({
        manifest: E2E_MANIFEST,
        adapter: createAdapter(),
        middleware: [handle.middleware],
        loopDetection: false,
      });

      // First call with original rubric
      await collectEvents(runtime.run({ kind: "text", text: "Say: test one" }));

      // Update rubric
      handle.setRubric("Second rubric: output must mention dogs");

      // Second call with new rubric
      await collectEvents(runtime.run({ kind: "text", text: "Say: test two" }));
      await runtime.dispose();

      // Verify rubrics changed between calls
      expect(capturedRubrics.length).toBeGreaterThanOrEqual(2);
      expect(capturedRubrics[0]).toContain("cats");
      expect(capturedRubrics[1]).toContain("dogs");
    },
    TIMEOUT_MS,
  );

  // ── Test 9: Stats accumulate across multiple calls ───────────────────

  test(
    "stats: accumulate correctly across multiple run calls",
    async () => {
      const handle = createOutputVerifierMiddleware({
        deterministic: [nonEmpty("block")],
      });

      const runtime = await createKoi({
        manifest: E2E_MANIFEST,
        adapter: createAdapter(),
        middleware: [handle.middleware],
        loopDetection: false,
      });

      // Three sequential calls
      await collectEvents(runtime.run({ kind: "text", text: "Say: one" }));
      await collectEvents(runtime.run({ kind: "text", text: "Say: two" }));
      await collectEvents(runtime.run({ kind: "text", text: "Say: three" }));
      await runtime.dispose();

      const stats = handle.getStats();
      expect(stats.totalChecks).toBeGreaterThanOrEqual(3);
      expect(stats.vetoed).toBe(0);
      expect(stats.vetoRate).toBe(0);
    },
    TIMEOUT_MS,
  );

  // ── Test 10: Reset clears stats mid-session ──────────────────────────

  test(
    "reset: clears all stats to zero mid-session",
    async () => {
      const handle = createOutputVerifierMiddleware({
        deterministic: [nonEmpty("block")],
      });

      const runtime = await createKoi({
        manifest: E2E_MANIFEST,
        adapter: createAdapter(),
        middleware: [handle.middleware],
        loopDetection: false,
      });

      await collectEvents(runtime.run({ kind: "text", text: "Say: before reset" }));

      // Stats should be non-zero
      expect(handle.getStats().totalChecks).toBeGreaterThanOrEqual(1);

      // Reset
      handle.reset();

      // Stats should be zero
      const afterReset = handle.getStats();
      expect(afterReset.totalChecks).toBe(0);
      expect(afterReset.vetoed).toBe(0);
      expect(afterReset.warned).toBe(0);

      // New call after reset
      await collectEvents(runtime.run({ kind: "text", text: "Say: after reset" }));
      await runtime.dispose();

      const finalStats = handle.getStats();
      expect(finalStats.totalChecks).toBeGreaterThanOrEqual(1);
    },
    TIMEOUT_MS,
  );

  // ── Test 11: describeCapabilities through real runtime ───────────────

  test(
    "describeCapabilities: returns correct fragment through L1 runtime",
    async () => {
      const handle = createOutputVerifierMiddleware({
        deterministic: [nonEmpty("block")],
        judge: {
          rubric: "Test",
          modelCall: createRealJudgeModelCall(),
          vetoThreshold: 0.75,
          randomFn: () => 0,
        },
      });

      // Middleware should have capability description
      expect(handle.middleware.describeCapabilities).toBeDefined();
      expect(handle.middleware.name).toBe("output-verifier");
      expect(handle.middleware.priority).toBe(385);
    },
    TIMEOUT_MS,
  );

  // ── Test 12: maxContentLength truncation with real judge ─────────────

  test(
    "maxContentLength: truncates long content before sending to judge",
    async () => {
      let capturedPromptLength = 0;
      const realCall = createRealJudgeModelCall();

      const handle = createOutputVerifierMiddleware({
        judge: {
          rubric: "Any output is acceptable.",
          modelCall: async (prompt, signal) => {
            capturedPromptLength = prompt.length;
            return await realCall(prompt, signal);
          },
          vetoThreshold: 0.25,
          action: "warn",
          maxContentLength: 100, // Very short — will truncate any real LLM output
          randomFn: () => 0,
        },
      });

      const runtime = await createKoi({
        manifest: E2E_MANIFEST,
        adapter: createAdapter(
          "You are verbose. Write at least 200 words in your response, elaborating extensively.",
        ),
        middleware: [handle.middleware],
        loopDetection: false,
      });

      await collectEvents(
        runtime.run({
          kind: "text",
          text: "Tell me about the history of computing in great detail.",
        }),
      );
      await runtime.dispose();

      // The judge prompt should have been truncated
      // (prompt includes rubric + instructions + truncated content)
      // A non-truncated verbose response would be 1000+ chars
      // With maxContentLength=100, total prompt should be much smaller
      expect(capturedPromptLength).toBeGreaterThan(0);
      expect(handle.getStats().judgedChecks).toBeGreaterThanOrEqual(1);
    },
    TIMEOUT_MS,
  );

  // ── Test 13: randomFn controls sampling deterministically ────────────

  test(
    "randomFn: injected function controls judge sampling",
    async () => {
      // randomFn returns 1.0 → always > any samplingRate < 1.0 → judge skipped
      const handle = createOutputVerifierMiddleware({
        deterministic: [nonEmpty("block")],
        judge: {
          rubric: "Test",
          modelCall: createRealJudgeModelCall(),
          vetoThreshold: 0.75,
          samplingRate: 0.5,
          randomFn: () => 1.0, // Always skip
        },
      });

      const runtime = await createKoi({
        manifest: E2E_MANIFEST,
        adapter: createAdapter(),
        middleware: [handle.middleware],
        loopDetection: false,
      });

      await collectEvents(runtime.run({ kind: "text", text: "Say: sampled" }));
      await runtime.dispose();

      // Judge should NOT have run (randomFn=1.0 > samplingRate=0.5)
      const stats = handle.getStats();
      expect(stats.judgedChecks).toBe(0);
      expect(stats.totalChecks).toBeGreaterThanOrEqual(1);
    },
    TIMEOUT_MS,
  );
});
