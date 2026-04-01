/**
 * E2E test — ACE default consolidator through the full L1 runtime assembly.
 *
 * Validates the complete learning loop:
 *   Session 1: model+tool calls → trajectory → curation → auto-consolidation
 *   Session 2: playbooks from session 1 injected into model context
 *
 * Gated on API key + E2E_TESTS=1 — tests skip when either is missing.
 * E2E tests require API keys AND explicit opt-in via E2E_TESTS=1 to avoid
 * rate-limit failures when 500+ test files run in parallel.
 *
 * Run:
 *   E2E_TESTS=1 OPENROUTER_API_KEY=... bun test src/__tests__/e2e.test.ts
 *   E2E_TESTS=1 ANTHROPIC_API_KEY=... bun test src/__tests__/e2e.test.ts
 */

import { describe, expect, test } from "bun:test";
import type { EngineEvent, EngineOutput, ModelRequest } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import { createAnthropicAdapter, createOpenRouterAdapter } from "@koi/model-router";
import { createAceMiddleware } from "../ace.js";
import { createInMemoryPlaybookStore, createInMemoryTrajectoryStore } from "../stores.js";
import type { CurationCandidate, Playbook, TrajectoryEntry } from "../types.js";

// ---------------------------------------------------------------------------
// Environment gate — accept either key
// ---------------------------------------------------------------------------

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? "";
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = OPENROUTER_KEY.length > 0 || ANTHROPIC_KEY.length > 0;
const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const describeE2E = HAS_KEY && E2E_OPTED_IN ? describe : describe.skip;

const TIMEOUT_MS = 60_000;

/** Build a ModelHandler from whichever key is available. */
function createModelCall(): (req: ModelRequest) => Promise<import("@koi/core").ModelResponse> {
  if (OPENROUTER_KEY.length > 0) {
    const adapter = createOpenRouterAdapter({
      apiKey: OPENROUTER_KEY,
      appName: "koi-ace-e2e",
    });
    return (req) => adapter.complete({ ...req, model: "openai/gpt-4o-mini" });
  }
  const adapter = createAnthropicAdapter({ apiKey: ANTHROPIC_KEY });
  return (req) => adapter.complete({ ...req, model: "claude-haiku-4-5-20251001" });
}

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

function findDoneOutput(events: readonly EngineEvent[]): EngineOutput | undefined {
  const done = events.find((e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done");
  return done?.output;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: ACE consolidator through createKoi + createLoopAdapter", () => {
  test(
    "full loop: session 1 auto-consolidates → session 2 injects playbooks",
    async () => {
      const trajectoryStore = createInMemoryTrajectoryStore();
      const playbookStore = createInMemoryPlaybookStore();
      const modelCall = createModelCall();

      // ── Session 1 ───────────────────────────────────────────
      const s1Recorded: TrajectoryEntry[] = [];
      const s1Curated: CurationCandidate[] = [];

      const ace1 = createAceMiddleware({
        trajectoryStore,
        playbookStore,
        onRecord: (entry) => s1Recorded.push(entry),
        onCurate: (candidates) => s1Curated.push(...candidates),
        minCurationScore: 0.01,
      });

      const adapter1 = createLoopAdapter({ modelCall, maxTurns: 3 });
      const runtime1 = await createKoi({
        manifest: { name: "ace-e2e-s1", version: "0.1.0", model: { name: "e2e" } },
        adapter: adapter1,
        middleware: [ace1],
        loopDetection: false,
      });

      const events1 = await collectEvents(
        runtime1.run({
          kind: "text",
          text: "Reply with exactly one word: hello",
        }),
      );
      await runtime1.dispose();

      const output1 = findDoneOutput(events1);
      expect(output1).toBeDefined();
      expect(output1?.stopReason === "completed" || output1?.stopReason === "max_turns").toBe(true);

      // Trajectories recorded
      expect(s1Recorded.length).toBeGreaterThan(0);

      // Curation ran
      expect(s1Curated.length).toBeGreaterThan(0);

      // Playbooks auto-consolidated (no custom consolidate function)
      const playbooks1 = await playbookStore.list();
      expect(playbooks1.length).toBeGreaterThan(0);

      // Validate playbook structure
      for (const pb of playbooks1) {
        expect(pb.id).toMatch(/^ace:(tool_call|model_call):/);
        expect(pb.source).toBe("curated");
        expect(pb.sessionCount).toBe(1);
        expect(pb.confidence).toBeGreaterThanOrEqual(0);
        expect(pb.confidence).toBeLessThanOrEqual(1);
        expect(pb.strategy.length).toBeGreaterThan(0);
      }

      // Trajectory persisted
      const sessions = await trajectoryStore.listSessions({ limit: 10 });
      expect(sessions.length).toBeGreaterThan(0);

      // ── Session 2 ───────────────────────────────────────────
      const s2Injected: Playbook[] = [];

      const ace2 = createAceMiddleware({
        trajectoryStore,
        playbookStore,
        onInject: (pbs) => s2Injected.push(...pbs),
        minCurationScore: 0.01,
      });

      const adapter2 = createLoopAdapter({ modelCall, maxTurns: 3 });
      const runtime2 = await createKoi({
        manifest: { name: "ace-e2e-s2", version: "0.1.0", model: { name: "e2e" } },
        adapter: adapter2,
        middleware: [ace2],
        loopDetection: false,
      });

      const events2 = await collectEvents(
        runtime2.run({
          kind: "text",
          text: "Reply with exactly one word: world",
        }),
      );
      await runtime2.dispose();

      const output2 = findDoneOutput(events2);
      expect(output2).toBeDefined();

      // Key assertion: playbooks from session 1 were injected into session 2
      expect(s2Injected.length).toBeGreaterThan(0);

      // Verify injected playbooks match what was consolidated in session 1
      const injectedIds = new Set(s2Injected.map((pb) => pb.id));
      const session1Ids = new Set(playbooks1.map((pb) => pb.id));
      const overlap = [...injectedIds].filter((id) => session1Ids.has(id));
      expect(overlap.length).toBeGreaterThan(0);
    },
    TIMEOUT_MS * 2,
  );
});
