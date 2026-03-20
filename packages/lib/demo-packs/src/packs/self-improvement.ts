/**
 * Self-improvement demo pack — seeds pre-recorded forge events, brick
 * metadata, and fitness history to demonstrate self-improvement observability.
 */

import { writeJson } from "@koi/nexus-client";
import type { DemoPack, SeedContext, SeededBrickView, SeedResult } from "../types.js";

// ---------------------------------------------------------------------------
// Seed data — forge events
// ---------------------------------------------------------------------------

const FORGE_EVENTS: readonly {
  readonly key: string;
  readonly value: Readonly<Record<string, unknown>>;
}[] = [
  {
    key: "brick_forged/tool-search-refine",
    value: {
      kind: "forge",
      subKind: "brick_forged",
      brickId: "brick-search-refine-001",
      name: "search-refine",
      origin: "crystallize",
      ngramKey: "search>filter>refine",
      occurrences: 12,
      score: 0.87,
      timestamp: Date.now() - 3_600_000,
    },
  },
  {
    key: "fitness_flushed/tool-search-refine",
    value: {
      kind: "forge",
      subKind: "fitness_flushed",
      brickId: "brick-search-refine-001",
      successRate: 0.92,
      sampleCount: 25,
      timestamp: Date.now() - 1_800_000,
    },
  },
  {
    key: "demand_detected/capability-gap-summarize",
    value: {
      kind: "forge",
      subKind: "demand_detected",
      signalId: "sig-summarize-001",
      triggerKind: "capability_gap",
      confidence: 0.78,
      suggestedBrickKind: "tool",
      timestamp: Date.now() - 7_200_000,
    },
  },
  {
    key: "crystallize_candidate/summarize-chain",
    value: {
      kind: "forge",
      subKind: "crystallize_candidate",
      ngramKey: "fetch>extract>summarize",
      occurrences: 8,
      suggestedName: "summarize-chain",
      score: 0.74,
      timestamp: Date.now() - 900_000,
    },
  },
];

// ---------------------------------------------------------------------------
// Seed data — brick metadata
// ---------------------------------------------------------------------------

const BRICK_METADATA: readonly {
  readonly key: string;
  readonly value: Readonly<Record<string, unknown>>;
}[] = [
  {
    key: "search-refine",
    value: {
      brickId: "brick-search-refine-001",
      name: "search-refine",
      status: "active",
      fitness: 0.92,
      sampleCount: 25,
      origin: "crystallize",
      ngramKey: "search>filter>refine",
      createdAt: Date.now() - 86_400_000,
      lastUpdatedAt: Date.now() - 1_800_000,
    },
  },
  {
    key: "code-explain",
    value: {
      brickId: "brick-code-explain-002",
      name: "code-explain",
      status: "promoted",
      fitness: 0.95,
      sampleCount: 48,
      origin: "crystallize",
      ngramKey: "read>parse>explain",
      createdAt: Date.now() - 172_800_000,
      lastUpdatedAt: Date.now() - 43_200_000,
    },
  },
  {
    key: "data-validate",
    value: {
      brickId: "brick-data-validate-003",
      name: "data-validate",
      status: "deprecated",
      fitness: 0.31,
      sampleCount: 15,
      origin: "crystallize",
      ngramKey: "fetch>validate>report",
      createdAt: Date.now() - 259_200_000,
      lastUpdatedAt: Date.now() - 86_400_000,
    },
  },
];

// ---------------------------------------------------------------------------
// Seed data — fitness history
// ---------------------------------------------------------------------------

const FITNESS_HISTORY: readonly {
  readonly key: string;
  readonly value: Readonly<Record<string, unknown>>;
}[] = [
  {
    key: "brick-search-refine-001",
    value: {
      brickId: "brick-search-refine-001",
      entries: [
        { successRate: 0.6, sampleCount: 5, timestamp: Date.now() - 86_400_000 },
        { successRate: 0.75, sampleCount: 12, timestamp: Date.now() - 43_200_000 },
        { successRate: 0.92, sampleCount: 25, timestamp: Date.now() - 1_800_000 },
      ],
    },
  },
  {
    key: "brick-code-explain-002",
    value: {
      brickId: "brick-code-explain-002",
      entries: [
        { successRate: 0.7, sampleCount: 10, timestamp: Date.now() - 172_800_000 },
        { successRate: 0.88, sampleCount: 30, timestamp: Date.now() - 86_400_000 },
        { successRate: 0.95, sampleCount: 48, timestamp: Date.now() - 43_200_000 },
      ],
    },
  },
];

// ---------------------------------------------------------------------------
// Seeder
// ---------------------------------------------------------------------------

async function seedSelfImprovement(ctx: SeedContext): Promise<SeedResult> {
  const counts: Record<string, number> = {};
  const summary: string[] = [];

  // 1. Seed forge events (parallel)
  const eventResults = await Promise.all(
    FORGE_EVENTS.map((entry) =>
      writeJson(
        ctx.nexusClient,
        `/agents/${ctx.agentName}/events/forge/${entry.key}`,
        entry.value,
      ).then((result) => {
        if (!result.ok && ctx.verbose) {
          summary.push(`  warn: failed to seed forge event ${entry.key}: ${result.error.message}`);
        }
        return result;
      }),
    ),
  );
  const eventCount = eventResults.filter((r) => r.ok).length;
  counts.forgeEvents = eventCount;
  summary.push(`Forge events: ${String(eventCount)} seeded`);

  // 2. Seed brick metadata (parallel)
  const brickResults = await Promise.all(
    BRICK_METADATA.map((entry) =>
      writeJson(ctx.nexusClient, `/global/bricks/${entry.key}`, entry.value).then((result) => {
        if (!result.ok && ctx.verbose) {
          summary.push(`  warn: failed to seed brick ${entry.key}: ${result.error.message}`);
        }
        return result;
      }),
    ),
  );
  const brickCount = brickResults.filter((r) => r.ok).length;
  counts.bricks = brickCount;
  summary.push(`Bricks: ${String(brickCount)} metadata entries ready`);

  // 3. Seed fitness history (parallel)
  const fitnessResults = await Promise.all(
    FITNESS_HISTORY.map((entry) =>
      writeJson(ctx.nexusClient, `/global/bricks/fitness/${entry.key}`, entry.value).then(
        (result) => {
          if (!result.ok && ctx.verbose) {
            summary.push(`  warn: failed to seed fitness ${entry.key}: ${result.error.message}`);
          }
          return result;
        },
      ),
    ),
  );
  const fitnessCount = fitnessResults.filter((r) => r.ok).length;
  counts.fitnessHistory = fitnessCount;
  summary.push(`Fitness history: ${String(fitnessCount)} entries ready`);

  const allSeeded =
    eventCount === FORGE_EVENTS.length &&
    brickCount === BRICK_METADATA.length &&
    fitnessCount === FITNESS_HISTORY.length;

  // Build seeded brick views for forge view hydration
  const seededBricks: readonly SeededBrickView[] = BRICK_METADATA.map((entry) => ({
    brickId: entry.value.brickId as string,
    name: entry.value.name as string,
    status: entry.value.status as SeededBrickView["status"],
    fitness: entry.value.fitness as number,
    sampleCount: entry.value.sampleCount as number,
    createdAt: entry.value.createdAt as number,
    lastUpdatedAt: entry.value.lastUpdatedAt as number,
  }));

  // Provide seeded forge events for timeline/demand panel hydration
  const seededForgeEvents = FORGE_EVENTS.map((entry) => entry.value);

  return { ok: allSeeded, counts, summary, seededBricks, seededForgeEvents };
}

export const SELF_IMPROVEMENT_PACK: DemoPack = {
  id: "self-improvement",
  name: "Self-Improvement",
  description: "Pre-recorded forge events, brick metadata, and fitness history for observability",
  requires: [],
  agentRoles: [
    {
      name: "primary",
      type: "copilot",
      lifecycle: "copilot",
      reuse: true,
      description: "Primary agent with self-improvement observability data",
    },
  ],
  seed: seedSelfImprovement,
  staticViews: {
    seededBricks: BRICK_METADATA.map((entry) => ({
      brickId: entry.value.brickId as string,
      name: entry.value.name as string,
      status: entry.value.status as SeededBrickView["status"],
      fitness: entry.value.fitness as number,
      sampleCount: entry.value.sampleCount as number,
      createdAt: entry.value.createdAt as number,
      lastUpdatedAt: entry.value.lastUpdatedAt as number,
    })),
    seededForgeEvents: FORGE_EVENTS.map((entry) => entry.value),
  },
  prompts: [
    "Show me the forge activity.",
    "What bricks have been created?",
    "How is the agent improving itself?",
  ],
} as const;
