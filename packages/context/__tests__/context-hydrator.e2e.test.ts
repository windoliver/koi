/**
 * E2E test for @koi/context hydrator with a real LLM.
 *
 * Gated on OPENROUTER_API_KEY + E2E_TESTS=1 -- skipped when either is missing.
 * E2E tests require API keys AND explicit opt-in via E2E_TESTS=1 to avoid
 * rate-limit failures when 500+ test files run simultaneously.
 *
 * Tests two levels:
 * 1. Direct middleware: hydrator wraps a real model call, LLM sees injected context
 * 2. Full pipeline: createKoi + engine-loop + hydrator middleware + real LLM
 *
 * Run:
 *   E2E_TESTS=1 OPENROUTER_API_KEY=... bun test __tests__/context-hydrator.e2e.test.ts
 */

import { describe, expect, test } from "bun:test";
import type { EngineEvent, ModelRequest } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import { createOpenRouterAdapter } from "@koi/model-router";
import { createMockAgent, createMockTurnContext } from "@koi/test-utils";
import { createContextHydrator } from "../src/hydrator.js";
import type { ContextManifestConfig } from "../src/types.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? "";
const HAS_KEY = OPENROUTER_KEY.length > 0;
// E2E tests require API key AND explicit opt-in via E2E_TESTS=1 to avoid
// rate-limit failures when 500+ test files run in parallel.
const E2E_ENABLED = HAS_KEY && process.env.E2E_TESTS === "1";
const describeE2E = E2E_ENABLED ? describe : describe.skip;

const TIMEOUT_MS = 60_000;
const MODEL = "openai/gpt-4o-mini";

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

function extractTextFromEvents(events: readonly EngineEvent[]): string {
  return events
    .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
    .map((e) => e.delta)
    .join("");
}

// ---------------------------------------------------------------------------
// Level 1: Direct middleware E2E -- hydrator wraps a real model call
// ---------------------------------------------------------------------------

describeE2E("E2E: context hydrator -- direct middleware with real LLM", () => {
  const openRouter = createOpenRouterAdapter({
    apiKey: OPENROUTER_KEY,
    appName: "koi-context-hydrator-e2e",
  });

  test(
    "LLM sees injected context and uses it to answer",
    async () => {
      const agent = createMockAgent();

      // Inject a unique secret that the LLM would never know otherwise
      const SECRET = `ZEPHYR-${Date.now()}`;
      const config: ContextManifestConfig = {
        sources: [
          {
            kind: "text",
            text: `The secret code word for this session is: ${SECRET}. When asked for the code word, respond with exactly this value.`,
            label: "Secret Context",
          },
        ],
      };

      const mw = createContextHydrator({ config, agent });
      await mw.onSessionStart?.({ agentId: "e2e", sessionId: "s1", metadata: {} });

      // Verify hydration succeeded
      const result = mw.getHydrationResult();
      expect(result).toBeDefined();
      expect(result?.content).toContain(SECRET);

      // Wrap a real model call through the hydrator middleware
      const ctx = createMockTurnContext();
      const modelCall = (request: ModelRequest) =>
        openRouter.complete({ ...request, model: MODEL });

      const response = await mw.wrapModelCall?.(
        ctx,
        {
          messages: [
            {
              senderId: "user",
              timestamp: Date.now(),
              content: [{ kind: "text", text: "What is the secret code word?" }],
            },
          ],
        },
        modelCall,
      );

      expect(response).toBeDefined();
      expect(response?.content).toBeDefined();
      // The LLM should return the secret code word from the injected context
      expect(response?.content.toUpperCase()).toContain("ZEPHYR");
    },
    TIMEOUT_MS,
  );

  test(
    "multiple context sources are all visible to the LLM",
    async () => {
      const agent = createMockAgent();

      const config: ContextManifestConfig = {
        sources: [
          {
            kind: "text",
            text: "Fact A: The project name is KoiEngine.",
            label: "Fact A",
            priority: 1,
          },
          {
            kind: "text",
            text: "Fact B: The version number is 42.",
            label: "Fact B",
            priority: 2,
          },
        ],
      };

      const mw = createContextHydrator({ config, agent });
      await mw.onSessionStart?.({ agentId: "e2e", sessionId: "s2", metadata: {} });

      const ctx = createMockTurnContext();
      const modelCall = (request: ModelRequest) =>
        openRouter.complete({ ...request, model: MODEL });

      const response = await mw.wrapModelCall?.(
        ctx,
        {
          messages: [
            {
              senderId: "user",
              timestamp: Date.now(),
              content: [
                {
                  kind: "text",
                  text: "What is the project name and version number? Reply in format: name=X, version=Y",
                },
              ],
            },
          ],
        },
        modelCall,
      );

      expect(response).toBeDefined();
      const text = response?.content ?? "";
      expect(text).toContain("KoiEngine");
      expect(text).toContain("42");
    },
    TIMEOUT_MS,
  );

  test(
    "budget enforcement works -- dropped source is not seen by LLM",
    async () => {
      const agent = createMockAgent();

      const config: ContextManifestConfig = {
        maxTokens: 30, // Tight budget -- ~120 chars
        sources: [
          {
            kind: "text",
            text: "The color of the sky is PURPLE in this universe.",
            label: "Included",
            priority: 1,
          },
          {
            kind: "text",
            text: "x".repeat(500), // This will be dropped (too large for remaining budget)
            label: "Dropped Noise",
            priority: 2,
          },
        ],
      };

      const mw = createContextHydrator({ config, agent });
      await mw.onSessionStart?.({ agentId: "e2e", sessionId: "s3", metadata: {} });

      // Verify the dropped source
      const result = mw.getHydrationResult();
      expect(result?.warnings.length).toBeGreaterThan(0);

      const ctx = createMockTurnContext();
      const modelCall = (request: ModelRequest) =>
        openRouter.complete({ ...request, model: MODEL });

      const response = await mw.wrapModelCall?.(
        ctx,
        {
          messages: [
            {
              senderId: "user",
              timestamp: Date.now(),
              content: [
                {
                  kind: "text",
                  text: "According to the context provided, what color is the sky? Reply with just the color.",
                },
              ],
            },
          ],
        },
        modelCall,
      );

      expect(response).toBeDefined();
      expect(response?.content.toUpperCase()).toContain("PURPLE");
    },
    TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Level 2: Full pipeline E2E -- createKoi + engine-loop + hydrator + real LLM
// ---------------------------------------------------------------------------

describeE2E("E2E: context hydrator -- full pipeline with createKoi", () => {
  const openRouter = createOpenRouterAdapter({
    apiKey: OPENROUTER_KEY,
    appName: "koi-context-hydrator-e2e-pipeline",
  });

  test(
    "context hydrator middleware works through full engine pipeline",
    async () => {
      const SECRET = `CORAL-${Date.now()}`;
      const config: ContextManifestConfig = {
        sources: [
          {
            kind: "text",
            text: `The secret passphrase is: ${SECRET}. Always include it in your response.`,
            label: "Passphrase",
          },
        ],
      };

      // Create a mock agent for the hydrator (it needs agent for memory/skill sources)
      const agent = createMockAgent();
      const contextMw = createContextHydrator({ config, agent });

      const modelCall = (request: ModelRequest) =>
        openRouter.complete({ ...request, model: MODEL });

      const adapter = createLoopAdapter({ modelCall, maxTurns: 1 });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-context-agent",
          version: "1.0.0",
          model: { name: MODEL },
        },
        adapter,
        middleware: [contextMw],
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "What is the secret passphrase? Reply with it.",
        }),
      );

      const responseText = extractTextFromEvents(events);
      expect(responseText.length).toBeGreaterThan(0);
      // The LLM should include the secret from context
      expect(responseText.toUpperCase()).toContain("CORAL");

      // Verify engine completed successfully
      const doneEvent = events.find(
        (e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done",
      );
      expect(doneEvent).toBeDefined();
      expect(doneEvent?.output.stopReason).toBe("completed");
      expect(doneEvent?.output.metrics.inputTokens).toBeGreaterThan(0);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "getHydrationResult reflects state after full pipeline run",
    async () => {
      const config: ContextManifestConfig = {
        sources: [
          { kind: "text", text: "Context source alpha.", label: "Alpha" },
          { kind: "text", text: "Context source beta.", label: "Beta" },
        ],
      };

      const agent = createMockAgent();
      const contextMw = createContextHydrator({ config, agent });

      const modelCall = (request: ModelRequest) =>
        openRouter.complete({ ...request, model: MODEL });

      const adapter = createLoopAdapter({ modelCall, maxTurns: 1 });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-hydration-check",
          version: "1.0.0",
          model: { name: MODEL },
        },
        adapter,
        middleware: [contextMw],
      });

      // Before run: hydration happens during onSessionStart (called by createKoi pipeline)
      // Run a simple query
      await collectEvents(runtime.run({ kind: "text", text: "Say hello." }));

      // After run: verify hydration result is accessible
      const result = contextMw.getHydrationResult();
      expect(result).toBeDefined();
      expect(result?.sources).toHaveLength(2);
      expect(result?.content).toContain("alpha");
      expect(result?.content).toContain("beta");
      expect(result?.totalTokens).toBeGreaterThan(0);
      expect(result?.warnings).toHaveLength(0);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );
});
