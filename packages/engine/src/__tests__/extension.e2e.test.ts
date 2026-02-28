/**
 * E2E tests for KernelExtension through the full createKoi() + Pi adapter path.
 *
 * Validates that the extension pipeline works end-to-end with real LLM calls:
 *   - Custom KernelExtension guards fire during a real agent run
 *   - Extension priority ordering is honored
 *   - Assembly validators run before the agent starts
 *   - Lifecycle validators gate state transitions
 *   - Default guards (iteration, spawn) compose with custom extensions
 *   - Middleware chain executes in correct order
 *
 * Gated on ANTHROPIC_API_KEY + E2E_TESTS=1 — skipped during parallel `bun test --recursive`
 * to avoid rate-limit failures when 500+ test files run simultaneously.
 *
 * Run:
 *   E2E_TESTS=1 ANTHROPIC_API_KEY=sk-ant-... bun test src/__tests__/extension.e2e.test.ts
 */

import { describe, expect, test } from "bun:test";
import type {
  AgentManifest,
  EngineEvent,
  EngineOutput,
  KernelExtension,
  KoiMiddleware,
} from "@koi/core";
import { EXTENSION_PRIORITY } from "@koi/core";
import { createPiAdapter } from "@koi/engine-pi";
import { createKoi } from "../koi.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
// E2E tests require API key AND explicit opt-in via E2E_TESTS=1 to avoid
// rate-limit failures when 500+ test files run in parallel.
const E2E_ENABLED = HAS_KEY && process.env.E2E_TESTS === "1";
const describeE2E = E2E_ENABLED ? describe : describe.skip;

const TIMEOUT_MS = 60_000;

// Use haiku for speed + cost
const E2E_MODEL = "anthropic:claude-haiku-4-5-20251001";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const E2E_MANIFEST: AgentManifest = {
  name: "extension-e2e-agent",
  version: "1.0.0",
  model: { name: "claude-haiku" },
};

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

function findDoneOutput(events: readonly EngineEvent[]): EngineOutput | undefined {
  const done = events.find((e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done");
  return done?.output;
}

function extractText(events: readonly EngineEvent[]): string {
  return events
    .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
    .map((e) => e.delta)
    .join("");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: KernelExtension through createKoi + Pi adapter", () => {
  test(
    "custom extension guard fires during real LLM call",
    async () => {
      const guardLog: string[] = [];

      const loggingExtension: KernelExtension = {
        name: "e2e:logging-guard",
        priority: EXTENSION_PRIORITY.USER,
        guards: () => [
          {
            name: "e2e:before-turn-logger",
            describeCapabilities: () => undefined,
            priority: 900,
            onBeforeTurn: async () => {
              guardLog.push("before-turn");
            },
            onAfterTurn: async () => {
              guardLog.push("after-turn");
            },
          },
        ],
      };

      const piAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a concise test assistant. Reply briefly.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: E2E_MANIFEST,
        adapter: piAdapter,
        extensions: [loggingExtension],
        loopDetection: false,
        limits: { maxTurns: 3, maxDurationMs: 55_000, maxTokens: 5_000 },
      });

      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Reply with exactly one word: pong" }),
      );

      // Verify real LLM output
      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");
      expect(output?.metrics.totalTokens).toBeGreaterThan(0);

      const text = extractText(events);
      expect(text.toLowerCase()).toContain("pong");

      // Verify custom guard fired
      expect(guardLog).toContain("before-turn");
      expect(guardLog).toContain("after-turn");

      // Verify lifecycle reached terminated
      expect(runtime.agent.state).toBe("terminated");
    },
    TIMEOUT_MS,
  );

  test(
    "multiple extensions compose correctly with real LLM",
    async () => {
      const order: string[] = [];

      const platformExtension: KernelExtension = {
        name: "e2e:platform-ext",
        priority: EXTENSION_PRIORITY.PLATFORM,
        guards: () => [
          {
            name: "e2e:platform-logger",
            describeCapabilities: () => undefined,
            priority: 5,
            onBeforeTurn: async () => {
              order.push("platform");
            },
          },
        ],
      };

      const userExtension: KernelExtension = {
        name: "e2e:user-ext",
        priority: EXTENSION_PRIORITY.USER,
        guards: () => [
          {
            name: "e2e:user-logger",
            describeCapabilities: () => undefined,
            priority: 6,
            onBeforeTurn: async () => {
              order.push("user");
            },
          },
        ],
      };

      const piAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a concise test assistant.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: E2E_MANIFEST,
        adapter: piAdapter,
        extensions: [userExtension, platformExtension],
        loopDetection: false,
        limits: { maxTurns: 3, maxDurationMs: 55_000, maxTokens: 5_000 },
      });

      await collectEvents(runtime.run({ kind: "text", text: "Reply with exactly: ok" }));

      // Both guards should have fired
      expect(order).toContain("platform");
      expect(order).toContain("user");

      // Platform (priority 5) runs before user (priority 6)
      expect(order.indexOf("platform")).toBeLessThan(order.indexOf("user"));

      expect(runtime.agent.state).toBe("terminated");
    },
    TIMEOUT_MS,
  );

  test(
    "assembly validator runs before real LLM call",
    async () => {
      // let justified: tracks whether assembly validator was called
      let assemblyCalled = false;

      const validatingExtension: KernelExtension = {
        name: "e2e:assembly-validator",
        priority: EXTENSION_PRIORITY.ADDON,
        validateAssembly: () => {
          assemblyCalled = true;
          return { ok: true };
        },
      };

      const piAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a concise test assistant.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: E2E_MANIFEST,
        adapter: piAdapter,
        extensions: [validatingExtension],
        loopDetection: false,
        limits: { maxTurns: 3, maxDurationMs: 55_000, maxTokens: 5_000 },
      });

      // Assembly validator runs during createKoi, before any LLM call
      expect(assemblyCalled).toBe(true);

      const events = await collectEvents(runtime.run({ kind: "text", text: "Reply: validated" }));

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(runtime.agent.state).toBe("terminated");
    },
    TIMEOUT_MS,
  );

  test(
    "default guards compose with custom extensions through real LLM",
    async () => {
      // let justified: tracks session hooks from custom middleware
      let sessionStarted = false;
      // let justified: tracks session hooks from custom middleware
      let sessionEnded = false;

      const customMiddleware: KoiMiddleware = {
        name: "e2e:session-tracker",
        describeCapabilities: () => undefined,
        priority: 500,
        onSessionStart: async () => {
          sessionStarted = true;
        },
        onSessionEnd: async () => {
          sessionEnded = true;
        },
      };

      // Extension that adds an additional guard alongside the default guards
      const extraGuardExtension: KernelExtension = {
        name: "e2e:extra-guard",
        priority: EXTENSION_PRIORITY.USER,
        guards: () => [
          {
            name: "e2e:noop-guard",
            describeCapabilities: () => undefined,
            priority: 999,
            onBeforeTurn: async () => {
              // no-op — just verifies it participates in the chain
            },
          },
        ],
      };

      const piAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a concise test assistant.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: E2E_MANIFEST,
        adapter: piAdapter,
        middleware: [customMiddleware],
        extensions: [extraGuardExtension],
        loopDetection: false,
        limits: { maxTurns: 3, maxDurationMs: 55_000, maxTokens: 5_000 },
      });

      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Reply with: composed" }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.metrics.totalTokens).toBeGreaterThan(0);

      // Session hooks from user middleware should have fired
      expect(sessionStarted).toBe(true);
      expect(sessionEnded).toBe(true);

      expect(runtime.agent.state).toBe("terminated");
    },
    TIMEOUT_MS,
  );

  test(
    "lifecycle validator allows normal transitions with real LLM",
    async () => {
      const transitions: string[] = [];

      const lifecycleExtension: KernelExtension = {
        name: "e2e:lifecycle-observer",
        priority: EXTENSION_PRIORITY.USER,
        validateTransition: (ctx) => {
          transitions.push(`${ctx.from}→${ctx.to}`);
          return true; // Allow all transitions
        },
      };

      const piAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a concise test assistant.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: E2E_MANIFEST,
        adapter: piAdapter,
        extensions: [lifecycleExtension],
        loopDetection: false,
        limits: { maxTurns: 3, maxDurationMs: 55_000, maxTokens: 5_000 },
      });

      await collectEvents(runtime.run({ kind: "text", text: "Reply with: lifecycle" }));

      // Significant transitions should have been observed
      // At minimum: created→running and running→terminated
      expect(transitions).toContain("created→running");

      // running→waiting and waiting→running are hot-path, should NOT appear
      expect(transitions).not.toContain("running→waiting");
      expect(transitions).not.toContain("waiting→running");

      expect(runtime.agent.state).toBe("terminated");
    },
    TIMEOUT_MS,
  );
});
