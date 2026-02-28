/**
 * End-to-end tests for @koi/self-test with real LLM calls.
 *
 * Validates the full self-test pipeline through createKoi (L1) + createPiAdapter:
 *   - Manifest checks pass for a real agent config
 *   - Middleware hooks are structurally valid
 *   - Engine adapter resolves, streams, yields done event through L1 runtime
 *   - E2E scenario completes with pattern matching against real LLM output
 *   - Full report is healthy
 *
 * Gated on ANTHROPIC_API_KEY — tests are skipped when the key is not set.
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-ant-... bun test src/__tests__/e2e.test.ts
 */

import { describe, expect, test } from "bun:test";
import type { AgentManifest, EngineAdapter, EngineInput, KoiMiddleware } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import { createSelfTest } from "../self-test.js";
import type { SelfTestScenario } from "../types.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
// E2E tests require API key AND explicit opt-in via E2E_TESTS=1 to avoid
// rate-limit failures when 500+ test files run in parallel.
const E2E_ENABLED = HAS_KEY && process.env.E2E_TESTS === "1";
const describeE2E = E2E_ENABLED ? describe : describe.skip;

const TIMEOUT_MS = 120_000;
const CHECK_TIMEOUT_MS = 60_000;

// Use haiku for speed + cost
const E2E_MODEL = "anthropic:claude-haiku-4-5-20251001";

// ---------------------------------------------------------------------------
// Shared config
// ---------------------------------------------------------------------------

const E2E_MANIFEST: AgentManifest = {
  name: "self-test-e2e-agent",
  version: "1.0.0",
  model: { name: "claude-haiku" },
};

/**
 * Factory that creates a KoiRuntime-backed EngineAdapter.
 *
 * Each call assembles a fresh createKoi runtime with the Pi adapter,
 * wrapping runtime.run() as adapter.stream(). This exercises the full
 * L1 path: assembly → guards → middleware composition → Pi adapter → real LLM.
 */
async function createKoiAdapter(middleware?: readonly KoiMiddleware[]): Promise<EngineAdapter> {
  const piAdapter = createPiAdapter({
    model: E2E_MODEL,
    systemPrompt: "You are a concise test assistant. Reply briefly and exactly as instructed.",
    getApiKey: async () => ANTHROPIC_KEY,
  });

  const runtime = await createKoi({
    manifest: E2E_MANIFEST,
    adapter: piAdapter,
    middleware: middleware ?? [],
    loopDetection: false,
    limits: { maxTurns: 5, maxDurationMs: 55_000, maxTokens: 10_000 },
  });

  return {
    engineId: "koi-pi-e2e",
    stream: (input: EngineInput) => runtime.run(input),
    dispose: () => runtime.dispose(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: self-test with real Anthropic API via createKoi + createPiAdapter", () => {
  test(
    "full self-test report is healthy with real LLM adapter",
    async () => {
      const observerMw: KoiMiddleware = {
        name: "e2e-observer",
        describeCapabilities: () => undefined,
        async onSessionStart() {
          // no-op — validates structural check passes
        },
        async onSessionEnd() {
          // no-op
        },
      };

      const scenario: SelfTestScenario = {
        name: "ping-pong",
        input: { kind: "text", text: "Reply with exactly one word: pong" },
        expectedPattern: /pong/i,
      };

      const st = createSelfTest({
        manifest: E2E_MANIFEST,
        adapter: () => createKoiAdapter([observerMw]),
        middleware: [observerMw],
        scenarios: [scenario],
        checkTimeoutMs: CHECK_TIMEOUT_MS,
        timeoutMs: TIMEOUT_MS,
      });

      const report = await st.run();

      // Log report for manual inspection
      for (const check of report.checks) {
        const icon = check.status === "pass" ? "+" : check.status === "fail" ? "x" : "-";
        const suffix = check.message !== undefined ? ` — ${check.message}` : "";
        console.log(`  [${icon}] ${check.name}${suffix}`);
      }
      console.log(
        `\n  Result: ${String(report.passed)} pass, ${String(report.failed)} fail, ${String(report.skipped)} skip`,
      );

      expect(report.healthy).toBe(true);
      expect(report.failed).toBe(0);
      expect(report.passed).toBeGreaterThan(0);

      // Engine checks should have run (not skipped)
      const engineChecks = report.checks.filter((c) => c.category === "engine");
      const passingEngineChecks = engineChecks.filter((c) => c.status === "pass");
      expect(passingEngineChecks.length).toBeGreaterThan(0);

      // Scenario check should have run and passed
      const scenarioChecks = report.checks.filter((c) => c.category === "scenarios");
      expect(scenarioChecks.length).toBeGreaterThan(0);
      const scenarioPass = scenarioChecks.find((c) => c.status === "pass");
      expect(scenarioPass).toBeDefined();

      // Middleware structural checks should pass
      const mwChecks = report.checks.filter((c) => c.category === "middleware");
      expect(mwChecks.length).toBeGreaterThan(0);
      for (const check of mwChecks) {
        expect(check.status).toBe("pass");
      }
    },
    TIMEOUT_MS,
  );

  test(
    "scenario with regex pattern matching against real LLM output",
    async () => {
      const scenario: SelfTestScenario = {
        name: "math-answer",
        input: { kind: "text", text: "What is 2 + 2? Reply with just the number." },
        expectedPattern: /4/,
      };

      const st = createSelfTest({
        manifest: E2E_MANIFEST,
        adapter: () => createKoiAdapter(),
        scenarios: [scenario],
        categories: ["scenarios"],
        checkTimeoutMs: CHECK_TIMEOUT_MS,
        timeoutMs: TIMEOUT_MS,
      });

      const report = await st.run();

      const scenarioCheck = report.checks.find(
        (c) => c.category === "scenarios" && c.name.includes("math-answer"),
      );
      expect(scenarioCheck?.status).toBe("pass");
    },
    TIMEOUT_MS,
  );

  test(
    "scenario custom assertion receives real events",
    async () => {
      // let justified: mutated in closure to verify assertion ran
      let assertionCalled = false;
      // let justified: capture token count for verification
      let tokenCount = 0;

      const scenario: SelfTestScenario = {
        name: "custom-assert",
        input: { kind: "text", text: "Say hello" },
        assert: (events) => {
          assertionCalled = true;
          const doneEvent = events.find((e) => e.kind === "done");
          if (doneEvent === undefined || doneEvent.kind !== "done") {
            throw new Error("No done event");
          }
          tokenCount = doneEvent.output.metrics.totalTokens;
          // Real LLM call should consume tokens
          if (doneEvent.output.metrics.totalTokens === 0) {
            throw new Error("Expected non-zero token count from real LLM");
          }
        },
      };

      const st = createSelfTest({
        manifest: E2E_MANIFEST,
        adapter: () => createKoiAdapter(),
        scenarios: [scenario],
        categories: ["scenarios"],
        checkTimeoutMs: CHECK_TIMEOUT_MS,
        timeoutMs: TIMEOUT_MS,
      });

      const report = await st.run();

      expect(assertionCalled).toBe(true);
      expect(tokenCount).toBeGreaterThan(0);

      const check = report.checks.find((c) => c.name.includes("custom-assert"));
      expect(check?.status).toBe("pass");
    },
    TIMEOUT_MS,
  );

  test(
    "engine checks pass through full L1 pipeline (dispose included for factory)",
    async () => {
      const st = createSelfTest({
        manifest: E2E_MANIFEST,
        adapter: () => createKoiAdapter(),
        categories: ["engine"],
        checkTimeoutMs: CHECK_TIMEOUT_MS,
        timeoutMs: TIMEOUT_MS,
      });

      const report = await st.run();

      const engineChecks = report.checks.filter((c) => c.category === "engine");
      // Factory mode: resolve + engineId + stream callable + stream yields done + output valid + dispose = 6
      expect(engineChecks).toHaveLength(6);

      for (const check of engineChecks) {
        if (check.status === "fail") {
          console.log(`  FAIL: ${check.name} — ${check.error?.message ?? "no error"}`);
        }
        expect(check.status).toBe("pass");
      }
    },
    TIMEOUT_MS,
  );
});
