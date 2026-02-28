/**
 * E2E: competitive-broadcast through the full Koi runtime stack.
 *
 * Validates that the selection + broadcast pipeline works end-to-end with
 * real Anthropic API calls flowing through createKoi + createPiAdapter.
 *
 * Tests:
 *   1. Parallel competing agents → first-wins selection → broadcast
 *   2. Scored selection on real LLM outputs
 *   3. Consensus selection with LLM-based judge
 *   4. Full createKoi + middleware chain + competitive-broadcast
 *   5. Event lifecycle fires correctly with real proposals
 *   6. Truncation on real verbose LLM output
 *   7. Abort signal cancels cycle mid-flight
 *
 * Run:
 *   E2E_TESTS=1 ANTHROPIC_API_KEY=sk-ant-... bun test src/__tests__/e2e-full-stack.test.ts
 *
 * Or via script:
 *   bun run test:e2e
 */

import { describe, expect, test } from "bun:test";
import type { AgentManifest, EngineEvent, EngineOutput, KoiMiddleware } from "@koi/core";
import { agentId } from "@koi/core/ecs";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import { createInMemoryBroadcastSink } from "../broadcast.js";
import { DEFAULT_CYCLE_CONFIG } from "../config.js";
import { runCycle } from "../cycle.js";
import {
  createConsensusSelector,
  createFirstWinsSelector,
  createScoredSelector,
} from "../selection.js";
import type { BroadcastResult, CycleEvent, Proposal, Vote } from "../types.js";
import { proposalId } from "../types.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const describeE2E = HAS_KEY && E2E_OPTED_IN ? describe : describe.skip;

const TIMEOUT_MS = 120_000;
const E2E_MODEL = "anthropic:claude-haiku-4-5-20251001";

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

function findDoneOutput(events: readonly EngineEvent[]): EngineOutput | undefined {
  const done = events.find((e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done");
  return done?.output;
}

function testManifest(name: string): AgentManifest {
  return {
    name,
    version: "0.1.0",
    model: { name: "claude-haiku-4-5" },
  };
}

/**
 * Spawn a real LLM agent via createKoi + createPiAdapter (full L1 runtime),
 * collect its text output, and return a Proposal with timing data.
 */
async function spawnCompetingAgent(opts: {
  readonly id: string;
  readonly prompt: string;
  readonly systemPrompt?: string;
}): Promise<Proposal> {
  const start = Date.now();

  const adapter = createPiAdapter({
    model: E2E_MODEL,
    systemPrompt: opts.systemPrompt ?? "You are a concise assistant. Reply briefly.",
    getApiKey: async () => ANTHROPIC_KEY,
  });

  const runtime = await createKoi({
    manifest: testManifest(`competitor-${opts.id}`),
    adapter,
    loopDetection: false,
  });

  const events = await collectEvents(runtime.run({ kind: "text", text: opts.prompt }));

  const durationMs = Date.now() - start;
  const output = extractText(events);
  const done = findDoneOutput(events);

  await runtime.dispose();

  return {
    id: proposalId(opts.id),
    agentId: agentId(`agent-${opts.id}`),
    output: output.length > 0 ? output : "(empty response)",
    durationMs,
    submittedAt: start,
    salience:
      done?.metrics.outputTokens !== undefined
        ? Math.min(1, done.metrics.outputTokens / 200)
        : undefined,
  };
}

/**
 * Spawn a real LLM agent through the full createKoi L1 runtime and return a Proposal.
 */
async function spawnViaKoiRuntime(opts: {
  readonly id: string;
  readonly prompt: string;
  readonly systemPrompt?: string;
  readonly middleware?: readonly KoiMiddleware[];
}): Promise<{ readonly proposal: Proposal; readonly events: readonly EngineEvent[] }> {
  const start = Date.now();

  const adapter = createPiAdapter({
    model: E2E_MODEL,
    systemPrompt: opts.systemPrompt ?? "You are a concise assistant. Reply briefly.",
    getApiKey: async () => ANTHROPIC_KEY,
  });

  const koiOpts = {
    manifest: testManifest(`competitor-${opts.id}`),
    adapter,
    loopDetection: false as const,
    ...(opts.middleware !== undefined ? { middleware: opts.middleware } : {}),
  };
  const runtime = await createKoi(koiOpts);

  const events = await collectEvents(runtime.run({ kind: "text", text: opts.prompt }));

  const durationMs = Date.now() - start;
  const output = extractText(events);
  const done = findDoneOutput(events);

  await runtime.dispose();

  const proposal: Proposal = {
    id: proposalId(opts.id),
    agentId: agentId(`agent-${opts.id}`),
    output: output.length > 0 ? output : "(empty response)",
    durationMs,
    submittedAt: start,
    salience:
      done?.metrics.outputTokens !== undefined
        ? Math.min(1, done.metrics.outputTokens / 200)
        : undefined,
  };

  return { proposal, events };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: competitive-broadcast full stack", () => {
  // ── Test 1: Parallel competing agents → first-wins selection ──────────

  test(
    "parallel agents compete → first-wins selects earliest submitter → broadcast delivers",
    async () => {
      // Spawn 3 agents in parallel with the same question
      const [p1, p2, p3] = await Promise.all([
        spawnCompetingAgent({
          id: "fast",
          prompt: "Reply with exactly one word: alpha",
          systemPrompt: "Reply with exactly one word. No explanation.",
        }),
        spawnCompetingAgent({
          id: "medium",
          prompt: "Reply with exactly one word: beta",
          systemPrompt: "Reply with exactly one word. No explanation.",
        }),
        spawnCompetingAgent({
          id: "slow",
          prompt: "Reply with exactly one word: gamma",
          systemPrompt: "Reply with exactly one word. No explanation.",
        }),
      ]);

      // All proposals should have non-empty output
      expect(p1.output.length).toBeGreaterThan(0);
      expect(p2.output.length).toBeGreaterThan(0);
      expect(p3.output.length).toBeGreaterThan(0);

      // Set up broadcast sink
      const received: BroadcastResult[] = [];
      const sink = createInMemoryBroadcastSink([
        async (r) => {
          received.push(r);
        },
        async (r) => {
          received.push(r);
        },
      ]);

      // Run cycle with first-wins selector
      const result = await runCycle(
        {
          strategy: createFirstWinsSelector(),
          sink,
          minProposals: DEFAULT_CYCLE_CONFIG.minProposals,
          maxOutputPerProposal: DEFAULT_CYCLE_CONFIG.maxOutputPerProposal,
        },
        [p1, p2, p3],
      );

      // Cycle should succeed
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Winner should be the one with the lowest submittedAt
      const earliest = [p1, p2, p3].sort((a, b) => a.submittedAt - b.submittedAt);
      const firstProposal = earliest[0];
      expect(firstProposal).toBeDefined();
      if (firstProposal === undefined) return;
      expect(result.value.winner.id).toBe(firstProposal.id);
      expect(result.value.allProposals).toHaveLength(3);

      // Broadcast should have been delivered to both recipients
      expect(received).toHaveLength(2);
      expect(received[0]?.winner.id).toBe(firstProposal.id);
      expect(received[1]?.winner.id).toBe(firstProposal.id);
    },
    TIMEOUT_MS,
  );

  // ── Test 2: Scored selection on real LLM outputs ─────────────────────

  test(
    "scored selector picks highest-salience proposal from real LLM outputs",
    async () => {
      // Spawn agents with different verbosity → different salience
      const [concise, verbose] = await Promise.all([
        spawnCompetingAgent({
          id: "concise",
          prompt: "What is 2+2?",
          systemPrompt: "Reply with just the number. Nothing else.",
        }),
        spawnCompetingAgent({
          id: "verbose",
          prompt: "What is 2+2? Explain your reasoning in detail with examples.",
          systemPrompt: "Be very thorough and detailed in your response. Explain step by step.",
        }),
      ]);

      // Override salience to make the test deterministic
      const conciseWithSalience: Proposal = { ...concise, salience: 0.3 };
      const verboseWithSalience: Proposal = { ...verbose, salience: 0.9 };

      const received: BroadcastResult[] = [];
      const sink = createInMemoryBroadcastSink([
        async (r) => {
          received.push(r);
        },
      ]);

      const result = await runCycle(
        {
          strategy: createScoredSelector(),
          sink,
          minProposals: DEFAULT_CYCLE_CONFIG.minProposals,
          maxOutputPerProposal: DEFAULT_CYCLE_CONFIG.maxOutputPerProposal,
        },
        [conciseWithSalience, verboseWithSalience],
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Scored selector should pick the one with higher salience
      expect(result.value.winner.id).toBe(proposalId("verbose"));
      expect(received).toHaveLength(1);
      expect(received[0]?.winner.output.length).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );

  // ── Test 3: Scored selection with custom scoreFn ─────────────────────

  test(
    "scored selector with custom scoreFn picks shortest output",
    async () => {
      const [short, long] = await Promise.all([
        spawnCompetingAgent({
          id: "short",
          prompt: "Say hi",
          systemPrompt: "Reply with one word only.",
        }),
        spawnCompetingAgent({
          id: "long",
          prompt: "Write a paragraph about the history of computing.",
          systemPrompt: "Be detailed and thorough.",
        }),
      ]);

      // Custom scorer: shorter output = higher score (inverse of length)
      const inverseLengthScorer = (p: Proposal): number => 1 / (1 + p.output.length);

      const received: BroadcastResult[] = [];
      const sink = createInMemoryBroadcastSink([
        async (r) => {
          received.push(r);
        },
      ]);

      const result = await runCycle(
        {
          strategy: createScoredSelector(inverseLengthScorer),
          sink,
          minProposals: DEFAULT_CYCLE_CONFIG.minProposals,
          maxOutputPerProposal: DEFAULT_CYCLE_CONFIG.maxOutputPerProposal,
        },
        [short, long],
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Shorter output should win
      expect(result.value.winner.id).toBe(proposalId("short"));
      expect(result.value.winner.output.length).toBeLessThan(long.output.length);
    },
    TIMEOUT_MS,
  );

  // ── Test 4: Consensus selection with deterministic judge ─────────────

  test(
    "consensus selector reaches consensus on real proposals",
    async () => {
      const [p1, p2] = await Promise.all([
        spawnCompetingAgent({
          id: "candidate-a",
          prompt: "What is the capital of France?",
          systemPrompt: "Reply with just the city name.",
        }),
        spawnCompetingAgent({
          id: "candidate-b",
          prompt: "Name a random European country capital.",
          systemPrompt: "Reply with just one city name.",
        }),
      ]);

      const received: BroadcastResult[] = [];
      const sink = createInMemoryBroadcastSink([
        async (r) => {
          received.push(r);
        },
      ]);

      // Judge strongly favors candidate-a (deterministic votes)
      const result = await runCycle(
        {
          strategy: createConsensusSelector({
            threshold: 0.6,
            judge: async (): Promise<readonly Vote[]> => [
              { proposalId: proposalId("candidate-a"), score: 0.9 },
              { proposalId: proposalId("candidate-b"), score: 0.1 },
            ],
          }),
          sink,
          minProposals: DEFAULT_CYCLE_CONFIG.minProposals,
          maxOutputPerProposal: DEFAULT_CYCLE_CONFIG.maxOutputPerProposal,
        },
        [p1, p2],
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.winner.id).toBe(proposalId("candidate-a"));
      expect(result.value.winner.output.toLowerCase()).toContain("paris");
      expect(received).toHaveLength(1);
    },
    TIMEOUT_MS,
  );

  // ── Test 5: Full createKoi L1 runtime → competitive-broadcast ───────

  test(
    "full createKoi + middleware chain → proposals → competitive-broadcast pipeline",
    async () => {
      const turnHooks: string[] = [];

      const observer: KoiMiddleware = {
        name: "e2e-observer",
        describeCapabilities: () => undefined,
        onSessionStart: async () => {
          turnHooks.push("session_start");
        },
        onSessionEnd: async () => {
          turnHooks.push("session_end");
        },
        onAfterTurn: async () => {
          turnHooks.push("after_turn");
        },
      };

      // Spawn 2 agents through the full createKoi L1 runtime
      const [agent1, agent2] = await Promise.all([
        spawnViaKoiRuntime({
          id: "koi-agent-1",
          prompt: "Reply with exactly: I am agent one",
          middleware: [observer],
        }),
        spawnViaKoiRuntime({
          id: "koi-agent-2",
          prompt: "Reply with exactly: I am agent two",
          middleware: [observer],
        }),
      ]);

      // Verify agents ran through L1 runtime (middleware fired)
      expect(turnHooks).toContain("session_start");
      expect(turnHooks).toContain("session_end");
      expect(turnHooks).toContain("after_turn");

      // Verify outputs are real LLM responses
      expect(agent1.proposal.output.length).toBeGreaterThan(0);
      expect(agent2.proposal.output.length).toBeGreaterThan(0);

      // Verify done events have metrics
      const done1 = findDoneOutput(agent1.events);
      const done2 = findDoneOutput(agent2.events);
      expect(done1).toBeDefined();
      expect(done2).toBeDefined();
      expect(done1?.metrics.inputTokens).toBeGreaterThan(0);
      expect(done2?.metrics.inputTokens).toBeGreaterThan(0);

      // Now feed through competitive-broadcast
      const cycleEvents: CycleEvent[] = [];
      const received: BroadcastResult[] = [];
      const sink = createInMemoryBroadcastSink([
        async (r) => {
          received.push(r);
        },
      ]);

      const result = await runCycle(
        {
          strategy: createFirstWinsSelector(),
          sink,
          minProposals: DEFAULT_CYCLE_CONFIG.minProposals,
          maxOutputPerProposal: DEFAULT_CYCLE_CONFIG.maxOutputPerProposal,
          onEvent: (e) => {
            cycleEvents.push(e);
          },
        },
        [agent1.proposal, agent2.proposal],
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Winner should have real content
      expect(result.value.winner.output.length).toBeGreaterThan(0);
      expect(result.value.allProposals).toHaveLength(2);

      // Broadcast delivered
      expect(received).toHaveLength(1);
      expect(received[0]?.cycleId).toContain("cycle-");

      // Cycle events fired correctly
      expect(cycleEvents).toHaveLength(4);
      expect(cycleEvents[0]?.kind).toBe("selection_started");
      expect(cycleEvents[1]?.kind).toBe("winner_selected");
      expect(cycleEvents[2]?.kind).toBe("broadcast_started");
      expect(cycleEvents[3]?.kind).toBe("broadcast_complete");
    },
    TIMEOUT_MS,
  );

  // ── Test 6: Event lifecycle with real proposals ──────────────────────

  test(
    "cycle events contain correct data from real LLM proposals",
    async () => {
      const proposal = await spawnCompetingAgent({
        id: "event-test",
        prompt: "Say hello",
        systemPrompt: "Reply with just: hello",
      });

      const cycleEvents: CycleEvent[] = [];
      const received: BroadcastResult[] = [];
      const sink = createInMemoryBroadcastSink([
        async (r) => {
          received.push(r);
        },
      ]);

      const result = await runCycle(
        {
          strategy: createFirstWinsSelector(),
          sink,
          minProposals: DEFAULT_CYCLE_CONFIG.minProposals,
          maxOutputPerProposal: DEFAULT_CYCLE_CONFIG.maxOutputPerProposal,
          onEvent: (e) => {
            cycleEvents.push(e);
          },
        },
        [proposal],
      );

      expect(result.ok).toBe(true);

      // Validate each event has correct data
      const selectionStarted = cycleEvents.find((e) => e.kind === "selection_started");
      expect(selectionStarted).toBeDefined();
      if (selectionStarted?.kind === "selection_started") {
        expect(selectionStarted.proposalCount).toBe(1);
      }

      const winnerSelected = cycleEvents.find((e) => e.kind === "winner_selected");
      expect(winnerSelected).toBeDefined();
      if (winnerSelected?.kind === "winner_selected") {
        expect(winnerSelected.winner.id).toBe(proposalId("event-test"));
        expect(winnerSelected.winner.output.length).toBeGreaterThan(0);
        expect(winnerSelected.winner.durationMs).toBeGreaterThan(0);
      }

      const broadcastStarted = cycleEvents.find((e) => e.kind === "broadcast_started");
      expect(broadcastStarted).toBeDefined();
      if (broadcastStarted?.kind === "broadcast_started") {
        expect(broadcastStarted.winnerId).toBe(proposalId("event-test"));
      }

      const broadcastComplete = cycleEvents.find((e) => e.kind === "broadcast_complete");
      expect(broadcastComplete).toBeDefined();
      if (broadcastComplete?.kind === "broadcast_complete") {
        expect(broadcastComplete.report.delivered).toBe(1);
        expect(broadcastComplete.report.failed).toBe(0);
      }
    },
    TIMEOUT_MS,
  );

  // ── Test 7: Truncation on real verbose LLM output ────────────────────

  test(
    "truncation works correctly on real verbose LLM output",
    async () => {
      const verbose = await spawnCompetingAgent({
        id: "verbose-truncation",
        prompt:
          "Write a detailed essay about the history of programming languages. Include at least 10 languages and their key contributions.",
        systemPrompt: "Be extremely detailed and thorough. Write at least 500 words.",
      });

      // Verify we got substantial output
      expect(verbose.output.length).toBeGreaterThan(100);

      const received: BroadcastResult[] = [];
      const sink = createInMemoryBroadcastSink([
        async (r) => {
          received.push(r);
        },
      ]);

      // Truncate to 200 chars
      const maxOutput = 200;
      const result = await runCycle(
        {
          strategy: createFirstWinsSelector(),
          sink,
          minProposals: DEFAULT_CYCLE_CONFIG.minProposals,
          maxOutputPerProposal: maxOutput,
        },
        [verbose],
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Winner output should be truncated
      expect(result.value.winner.output.length).toBeLessThanOrEqual(maxOutput);
      expect(result.value.winner.output).toContain("[output truncated]");

      // Broadcast should also have the truncated version
      expect(received).toHaveLength(1);
      expect(received[0]?.winner.output.length).toBeLessThanOrEqual(maxOutput);
    },
    TIMEOUT_MS,
  );

  // ── Test 8: Abort signal cancels cycle ───────────────────────────────

  test(
    "abort signal prevents broadcast of real proposals",
    async () => {
      const proposal = await spawnCompetingAgent({
        id: "abort-test",
        prompt: "Say hello",
        systemPrompt: "Reply with just: hello",
      });

      const controller = new AbortController();
      controller.abort("e2e test abort");

      const received: BroadcastResult[] = [];
      const sink = createInMemoryBroadcastSink([
        async (r) => {
          received.push(r);
        },
      ]);

      const cycleEvents: CycleEvent[] = [];
      const result = await runCycle(
        {
          strategy: createFirstWinsSelector(),
          sink,
          minProposals: DEFAULT_CYCLE_CONFIG.minProposals,
          maxOutputPerProposal: DEFAULT_CYCLE_CONFIG.maxOutputPerProposal,
          signal: controller.signal,
          onEvent: (e) => {
            cycleEvents.push(e);
          },
        },
        [proposal],
      );

      // Cycle should fail with abort error
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("TIMEOUT");
        expect(result.error.message).toContain("aborted");
      }

      // No broadcast should have happened
      expect(received).toHaveLength(0);

      // Error event should have fired
      const errorEvent = cycleEvents.find((e) => e.kind === "cycle_error");
      expect(errorEvent).toBeDefined();
    },
    TIMEOUT_MS,
  );

  // ── Test 9: Multiple broadcast recipients receive real results ───────

  test(
    "multiple recipients all receive the broadcast with real proposal data",
    async () => {
      const proposal = await spawnCompetingAgent({
        id: "multi-recipient",
        prompt: "What is the meaning of life? Reply in one sentence.",
        systemPrompt: "Be concise.",
      });

      const received1: BroadcastResult[] = [];
      const received2: BroadcastResult[] = [];
      const received3: BroadcastResult[] = [];
      const sink = createInMemoryBroadcastSink([
        async (r) => {
          received1.push(r);
        },
        async (r) => {
          received2.push(r);
        },
        async (r) => {
          received3.push(r);
        },
      ]);

      const result = await runCycle(
        {
          strategy: createFirstWinsSelector(),
          sink,
          minProposals: DEFAULT_CYCLE_CONFIG.minProposals,
          maxOutputPerProposal: DEFAULT_CYCLE_CONFIG.maxOutputPerProposal,
        },
        [proposal],
      );

      expect(result.ok).toBe(true);

      // All 3 recipients should have received the same winner
      expect(received1).toHaveLength(1);
      expect(received2).toHaveLength(1);
      expect(received3).toHaveLength(1);

      const w1 = received1[0]?.winner;
      const w2 = received2[0]?.winner;
      const w3 = received3[0]?.winner;
      expect(w1?.id).toBe(proposalId("multi-recipient"));
      expect(w2?.id).toBe(proposalId("multi-recipient"));
      expect(w3?.id).toBe(proposalId("multi-recipient"));

      // All should have the same output
      expect(w1?.output).toBe(w2?.output);
      expect(w2?.output).toBe(w3?.output);
    },
    TIMEOUT_MS,
  );

  // ── Test 10: End-to-end with all three strategies on same proposals ──

  test(
    "all three strategies can process the same real proposals",
    async () => {
      // Spawn 2 agents once, reuse proposals across all strategies
      const [early, late] = await Promise.all([
        spawnCompetingAgent({
          id: "early-bird",
          prompt: "Say: first",
          systemPrompt: "Reply with one word.",
        }),
        spawnCompetingAgent({
          id: "late-comer",
          prompt: "Say: second",
          systemPrompt: "Reply with one word.",
        }),
      ]);

      // Override timing to make order deterministic
      const earlyProposal: Proposal = { ...early, submittedAt: 1000, salience: 0.3 };
      const lateProposal: Proposal = { ...late, submittedAt: 2000, salience: 0.9 };
      const proposals = [earlyProposal, lateProposal];

      // Strategy 1: first-wins → picks earliest submittedAt
      const r1 = await runCycle(
        {
          strategy: createFirstWinsSelector(),
          sink: createInMemoryBroadcastSink([]),
          minProposals: DEFAULT_CYCLE_CONFIG.minProposals,
          maxOutputPerProposal: DEFAULT_CYCLE_CONFIG.maxOutputPerProposal,
        },
        proposals,
      );
      expect(r1.ok).toBe(true);
      if (r1.ok) expect(r1.value.winner.id).toBe(proposalId("early-bird"));

      // Strategy 2: scored → picks highest salience
      const r2 = await runCycle(
        {
          strategy: createScoredSelector(),
          sink: createInMemoryBroadcastSink([]),
          minProposals: DEFAULT_CYCLE_CONFIG.minProposals,
          maxOutputPerProposal: DEFAULT_CYCLE_CONFIG.maxOutputPerProposal,
        },
        proposals,
      );
      expect(r2.ok).toBe(true);
      if (r2.ok) expect(r2.value.winner.id).toBe(proposalId("late-comer"));

      // Strategy 3: consensus → picks the one with highest vote share
      const r3 = await runCycle(
        {
          strategy: createConsensusSelector({
            threshold: 0.5,
            judge: async (): Promise<readonly Vote[]> => [
              { proposalId: proposalId("early-bird"), score: 0.7 },
              { proposalId: proposalId("late-comer"), score: 0.3 },
            ],
          }),
          sink: createInMemoryBroadcastSink([]),
          minProposals: DEFAULT_CYCLE_CONFIG.minProposals,
          maxOutputPerProposal: DEFAULT_CYCLE_CONFIG.maxOutputPerProposal,
        },
        proposals,
      );
      expect(r3.ok).toBe(true);
      if (r3.ok) expect(r3.value.winner.id).toBe(proposalId("early-bird"));

      // All three should have selected from the same proposal set
      if (r1.ok) expect(r1.value.allProposals).toHaveLength(2);
      if (r2.ok) expect(r2.value.allProposals).toHaveLength(2);
      if (r3.ok) expect(r3.value.allProposals).toHaveLength(2);
    },
    TIMEOUT_MS,
  );
});
