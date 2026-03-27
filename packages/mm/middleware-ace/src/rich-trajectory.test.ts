/**
 * Tests for rich trajectory pipeline integration and reflector prompt formatting.
 *
 * Covers:
 * 1. formatRichTrajectory — snapshot-style output verification
 * 2. compressRichTrajectory — budget-aware compression with priority ordering
 * 3. Pipeline integration — richTrajectorySource → reflector → store lifecycle
 */

import { describe, expect, mock, test } from "bun:test";
import type { RichTrajectoryStep } from "@koi/core/rich-trajectory";
import type { AceConfig } from "./config.js";
import { compressRichTrajectory, createLlmPipeline } from "./pipeline.js";
import { formatRichTrajectory } from "./reflector.js";
import {
  createInMemoryPlaybookStore,
  createInMemoryRichTrajectoryStore,
  createInMemoryStructuredPlaybookStore,
  createInMemoryTrajectoryStore,
} from "./stores.js";
import { createTrajectoryBuffer } from "./trajectory-buffer.js";
import type { TrajectoryEntry } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRichStep(overrides?: Partial<RichTrajectoryStep>): RichTrajectoryStep {
  return {
    stepIndex: 0,
    timestamp: 1000,
    source: "agent",
    kind: "model_call",
    identifier: "claude-3",
    outcome: "success",
    durationMs: 200,
    ...overrides,
  };
}

function makeEntry(overrides?: Partial<TrajectoryEntry>): TrajectoryEntry {
  return {
    turnIndex: 0,
    timestamp: 1000,
    kind: "tool_call",
    identifier: "tool-a",
    outcome: "success",
    durationMs: 50,
    ...overrides,
  };
}

function makeMinimalConfig(overrides?: Partial<AceConfig>): AceConfig {
  return {
    trajectoryStore: createInMemoryTrajectoryStore(),
    playbookStore: createInMemoryPlaybookStore(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. formatRichTrajectory (snapshot-style tests)
// ---------------------------------------------------------------------------

describe("formatRichTrajectory", () => {
  test("empty steps returns empty string", () => {
    const result = formatRichTrajectory([]);
    expect(result).toBe("");
  });

  test("model call with request, reasoning, and response includes all parts", () => {
    const step = makeRichStep({
      kind: "model_call",
      identifier: "claude-3",
      outcome: "success",
      durationMs: 350,
      request: { text: "What is the capital of France?" },
      reasoningContent: "The user is asking about geography.",
      response: { text: "Paris is the capital of France." },
    });

    const result = formatRichTrajectory([step]);

    expect(result).toContain("- [model_call] claude-3: success (350ms)");
    expect(result).toContain("  Request: What is the capital of France?");
    expect(result).toContain("  Reasoning: The user is asking about geography.");
    expect(result).toContain("  Response: Paris is the capital of France.");
  });

  test("tool call with request and error includes error line", () => {
    const step = makeRichStep({
      kind: "tool_call",
      identifier: "read-file",
      outcome: "failure",
      durationMs: 15,
      source: "tool",
      request: { text: '{"path": "/tmp/missing.txt"}' },
      error: { text: "ENOENT: no such file or directory" },
    });

    const result = formatRichTrajectory([step]);

    expect(result).toContain("- [tool_call] read-file: failure (15ms)");
    expect(result).toContain('  Request: {"path": "/tmp/missing.txt"}');
    expect(result).toContain("  Error: ENOENT: no such file or directory");
    // No response or reasoning lines
    expect(result).not.toContain("Response:");
    expect(result).not.toContain("Reasoning:");
  });

  test("truncated content includes [truncated] marker", () => {
    const step = makeRichStep({
      request: { text: "short request", truncated: true, originalSize: 50000 },
      response: { text: "short response", truncated: true, originalSize: 30000 },
    });

    const result = formatRichTrajectory([step]);

    expect(result).toContain("  Request: short request [truncated]");
    expect(result).toContain("  Response: short response [truncated]");
  });

  test("renders all steps (no internal slicing — caller handles budget)", () => {
    // formatRichTrajectory does not slice; compressRichTrajectory handles selection
    const steps = Array.from({ length: 15 }, (_, i) =>
      makeRichStep({
        stepIndex: i,
        identifier: `id-${String(i).padStart(2, "0")}`,
        request: { text: `request-${String(i).padStart(2, "0")}` },
      }),
    );

    const result = formatRichTrajectory(steps);

    // All 15 steps should be included
    for (let i = 0; i < 15; i++) {
      expect(result).toContain(`id-${String(i).padStart(2, "0")}`);
    }
  });

  test("output format matches expected structure for LLM consumption", () => {
    const steps = [
      makeRichStep({
        stepIndex: 0,
        kind: "model_call",
        identifier: "claude-3",
        outcome: "success",
        durationMs: 100,
        request: { text: "Analyze this code" },
        response: { text: "The code looks correct" },
      }),
      makeRichStep({
        stepIndex: 1,
        kind: "tool_call",
        identifier: "write-file",
        outcome: "failure",
        durationMs: 25,
        source: "tool",
        request: { text: '{"path": "/etc/config"}' },
        error: { text: "Permission denied" },
      }),
    ];

    const result = formatRichTrajectory(steps);
    const lines = result.split("\n");

    // First step header
    expect(lines[0]).toBe("- [model_call] claude-3: success (100ms)");
    expect(lines[1]).toBe("  Request: Analyze this code");
    expect(lines[2]).toBe("  Response: The code looks correct");
    // Second step header
    expect(lines[3]).toBe("- [tool_call] write-file: failure (25ms)");
    expect(lines[4]).toBe('  Request: {"path": "/etc/config"}');
    expect(lines[5]).toBe("  Error: Permission denied");
  });

  test("step with only header line and no content fields", () => {
    const step = makeRichStep({
      kind: "tool_call",
      identifier: "list-dir",
      outcome: "success",
      durationMs: 5,
    });

    const result = formatRichTrajectory([step]);

    expect(result).toBe("- [tool_call] list-dir: success (5ms)");
  });
});

// ---------------------------------------------------------------------------
// 2. compressRichTrajectory (budget-aware compression)
// ---------------------------------------------------------------------------

describe("compressRichTrajectory", () => {
  test("empty steps returns empty array", () => {
    const result = compressRichTrajectory([], 4000);
    expect(result).toEqual([]);
  });

  test("steps within budget are all included", () => {
    const steps = [
      makeRichStep({ stepIndex: 0, request: { text: "hello" } }),
      makeRichStep({ stepIndex: 1, request: { text: "world" } }),
    ];

    const result = compressRichTrajectory(steps, 4000);
    expect(result).toHaveLength(2);
  });

  test("steps exceeding budget are truncated to fit", () => {
    // Create steps with large content that exceeds budget
    const longText = "x".repeat(2000);
    const steps = Array.from({ length: 10 }, (_, i) =>
      makeRichStep({
        stepIndex: i,
        timestamp: 1000 + i,
        request: { text: longText },
        response: { text: longText },
      }),
    );

    // Very small budget — should not fit all 10 steps
    const result = compressRichTrajectory(steps, 500);
    expect(result.length).toBeLessThan(steps.length);
    expect(result.length).toBeGreaterThan(0);
  });

  test("failures prioritized over successes", () => {
    const steps = [
      makeRichStep({
        stepIndex: 0,
        timestamp: 1000,
        outcome: "success",
        request: { text: "a".repeat(1000) },
      }),
      makeRichStep({
        stepIndex: 1,
        timestamp: 2000,
        outcome: "failure",
        request: { text: "b".repeat(1000) },
      }),
      makeRichStep({
        stepIndex: 2,
        timestamp: 3000,
        outcome: "success",
        request: { text: "c".repeat(1000) },
      }),
    ];

    // Budget only allows ~1 step
    const result = compressRichTrajectory(steps, 300);
    expect(result.length).toBeGreaterThanOrEqual(1);
    // The failure step should be included
    expect(result.some((s) => s.outcome === "failure")).toBe(true);
  });

  test("steps with bulletIds prioritized over plain successes", () => {
    const steps = [
      makeRichStep({
        stepIndex: 0,
        timestamp: 1000,
        outcome: "success",
        request: { text: "a".repeat(1000) },
      }),
      makeRichStep({
        stepIndex: 1,
        timestamp: 2000,
        outcome: "success",
        bulletIds: ["[str-00001]"],
        request: { text: "b".repeat(1000) },
      }),
      makeRichStep({
        stepIndex: 2,
        timestamp: 3000,
        outcome: "success",
        request: { text: "c".repeat(1000) },
      }),
    ];

    // Budget allows ~1 step
    const result = compressRichTrajectory(steps, 300);
    expect(result.length).toBeGreaterThanOrEqual(1);
    // The step with bulletIds should be included
    expect(result.some((s) => s.bulletIds !== undefined && s.bulletIds.length > 0)).toBe(true);
  });

  test("result sorted by stepIndex (chronological order)", () => {
    const steps = [
      makeRichStep({ stepIndex: 3, timestamp: 4000, outcome: "success" }),
      makeRichStep({ stepIndex: 1, timestamp: 2000, outcome: "failure" }),
      makeRichStep({ stepIndex: 2, timestamp: 3000, outcome: "success" }),
      makeRichStep({ stepIndex: 0, timestamp: 1000, outcome: "success" }),
    ];

    const result = compressRichTrajectory(steps, 4000);

    for (let i = 1; i < result.length; i++) {
      const prev = result[i - 1];
      const curr = result[i];
      if (prev !== undefined && curr !== undefined) {
        expect(prev.stepIndex).toBeLessThan(curr.stepIndex);
      }
    }
  });

  test("content truncated when individual steps are too large", () => {
    const longText = "x".repeat(5000);
    const steps = [
      makeRichStep({
        stepIndex: 0,
        timestamp: 2000, // More recent → processed first by priority sort
        outcome: "failure",
        request: { text: "first failure" },
      }),
      makeRichStep({
        stepIndex: 1,
        timestamp: 1000, // Older → processed second, subject to truncation
        outcome: "failure",
        request: { text: longText },
        response: { text: longText },
      }),
    ];

    // Budget that fits the first (small) failure at full size but requires
    // truncation of the second (large) one. The compressor adds the first
    // step unconditionally, then truncates the second to fit the remainder.
    const result = compressRichTrajectory(steps, 800);

    // Both failures should be included (both highest priority)
    expect(result.length).toBe(2);

    // The second step should have truncated content
    const largeStep = result.find((s) => s.stepIndex === 1);
    expect(largeStep).toBeDefined();
    if (largeStep?.request?.text !== undefined) {
      expect(largeStep.request.text.length).toBeLessThan(longText.length);
      expect(largeStep.request.truncated).toBe(true);
    }
  });

  test("retry outcome has same priority as failure", () => {
    const steps = [
      makeRichStep({
        stepIndex: 0,
        timestamp: 1000,
        outcome: "success",
        request: { text: "a".repeat(1000) },
      }),
      makeRichStep({
        stepIndex: 1,
        timestamp: 2000,
        outcome: "retry",
        request: { text: "b".repeat(1000) },
      }),
    ];

    // Budget allows ~1 step
    const result = compressRichTrajectory(steps, 300);
    expect(result.length).toBeGreaterThanOrEqual(1);
    // Retry should be prioritized same as failure
    expect(result.some((s) => s.outcome === "retry")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Pipeline integration with rich trajectory
// ---------------------------------------------------------------------------

describe("pipeline integration with rich trajectory", () => {
  test("passes richTrajectory to reflector when richTrajectorySource is configured", async () => {
    const richSteps: readonly RichTrajectoryStep[] = [
      makeRichStep({
        stepIndex: 0,
        kind: "model_call",
        identifier: "claude-3",
        outcome: "success",
        request: { text: "analyze code" },
        response: { text: "looks good" },
      }),
      makeRichStep({
        stepIndex: 1,
        kind: "tool_call",
        identifier: "read-file",
        outcome: "failure",
        error: { text: "not found" },
      }),
    ];

    const analyze = mock((_: unknown) =>
      Promise.resolve({ rootCause: "test", keyInsight: "test", bulletTags: [] as const }),
    );
    const curate = mock(() => Promise.resolve([]));
    const richTrajectorySource = mock(() => Promise.resolve(richSteps));
    const richTrajectoryStore = createInMemoryRichTrajectoryStore();
    const onLlmPipelineComplete = mock(() => {});

    const config = makeMinimalConfig({
      reflector: { analyze },
      curator: { curate },
      structuredPlaybookStore: createInMemoryStructuredPlaybookStore(),
      richTrajectorySource,
      richTrajectoryStore,
      onLlmPipelineComplete,
    });

    const pipeline = createLlmPipeline(config);
    const buffer = createTrajectoryBuffer(100);
    const entries = [makeEntry({ outcome: "success" })];

    await pipeline.consolidate(entries, "session-rt-1", 1, () => 2000, buffer);

    // Verify reflector.analyze received richTrajectory field
    expect(analyze).toHaveBeenCalledTimes(1);
    const analyzeInput = analyze.mock.calls[0]?.[0] as
      | { readonly richTrajectory?: readonly RichTrajectoryStep[] }
      | undefined;
    expect(analyzeInput?.richTrajectory).toBeDefined();
    expect(analyzeInput?.richTrajectory?.length).toBe(2);
  });

  test("richTrajectoryStore.append is called with fetched steps", async () => {
    const richSteps: readonly RichTrajectoryStep[] = [
      makeRichStep({ stepIndex: 0, identifier: "model-a" }),
    ];

    const analyze = mock(() => Promise.resolve({ rootCause: "", keyInsight: "", bulletTags: [] }));
    const curate = mock(() => Promise.resolve([]));
    const richTrajectorySource = mock(() => Promise.resolve(richSteps));
    const richTrajectoryStore = createInMemoryRichTrajectoryStore();

    const config = makeMinimalConfig({
      reflector: { analyze },
      curator: { curate },
      structuredPlaybookStore: createInMemoryStructuredPlaybookStore(),
      richTrajectorySource,
      richTrajectoryStore,
    });

    const pipeline = createLlmPipeline(config);
    const buffer = createTrajectoryBuffer(100);

    await pipeline.consolidate([makeEntry()], "session-store-1", 1, () => 2000, buffer);

    // Verify data was persisted to the store
    const stored = await richTrajectoryStore.getSession("session-store-1");
    expect(stored.length).toBeGreaterThan(0);
  });

  test("richTrajectoryStore.prune is called with correct cutoff", async () => {
    const nowMs = 100_000_000_000;
    const retentionDays = 30;
    // cutoff = nowMs - 30 * 86_400_000 = 97_408_000_000
    // New session steps must have a timestamp > cutoff to survive pruning
    const recentTimestamp = nowMs - 1000;

    const richSteps: readonly RichTrajectoryStep[] = [
      makeRichStep({ stepIndex: 0, timestamp: recentTimestamp }),
    ];

    const analyze = mock(() => Promise.resolve({ rootCause: "", keyInsight: "", bulletTags: [] }));
    const curate = mock(() => Promise.resolve([]));
    const richTrajectorySource = mock(() => Promise.resolve(richSteps));
    const richTrajectoryStore = createInMemoryRichTrajectoryStore();

    // Seed an old session that should be pruned (timestamp well before cutoff)
    const oldTimestamp = 100;
    await richTrajectoryStore.append("old-session", [
      makeRichStep({ stepIndex: 0, timestamp: oldTimestamp }),
    ]);

    const config = makeMinimalConfig({
      reflector: { analyze },
      curator: { curate },
      structuredPlaybookStore: createInMemoryStructuredPlaybookStore(),
      richTrajectorySource,
      richTrajectoryStore,
      richTrajectoryRetentionDays: retentionDays,
    });

    const pipeline = createLlmPipeline(config);
    const buffer = createTrajectoryBuffer(100);

    await pipeline.consolidate([makeEntry()], "new-session", 1, () => nowMs, buffer);

    // The old session should have been pruned because its timestamp < cutoff
    const oldStored = await richTrajectoryStore.getSession("old-session");
    expect(oldStored).toHaveLength(0);

    // The new session should remain (its timestamp > cutoff)
    const newStored = await richTrajectoryStore.getSession("new-session");
    expect(newStored.length).toBeGreaterThan(0);
  });

  test("onLlmPipelineComplete is called on success", async () => {
    const richSteps: readonly RichTrajectoryStep[] = [
      makeRichStep({ stepIndex: 0, identifier: "test-model" }),
    ];

    const analyze = mock(() => Promise.resolve({ rootCause: "", keyInsight: "", bulletTags: [] }));
    const curate = mock(() => Promise.resolve([]));
    const richTrajectorySource = mock(() => Promise.resolve(richSteps));
    const richTrajectoryStore = createInMemoryRichTrajectoryStore();
    const onLlmPipelineComplete = mock(() => {});

    const config = makeMinimalConfig({
      reflector: { analyze },
      curator: { curate },
      structuredPlaybookStore: createInMemoryStructuredPlaybookStore(),
      richTrajectorySource,
      richTrajectoryStore,
      onLlmPipelineComplete,
    });

    const pipeline = createLlmPipeline(config);
    const buffer = createTrajectoryBuffer(100);

    await pipeline.consolidate([makeEntry()], "session-complete-1", 1, () => 2000, buffer);

    expect(onLlmPipelineComplete).toHaveBeenCalledTimes(1);
    expect(onLlmPipelineComplete).toHaveBeenCalledWith("session-complete-1");
  });

  test("reflector receives undefined richTrajectory when no source configured", async () => {
    const analyze = mock((_: unknown) =>
      Promise.resolve({ rootCause: "", keyInsight: "", bulletTags: [] as const }),
    );
    const curate = mock(() => Promise.resolve([]));

    const config = makeMinimalConfig({
      reflector: { analyze },
      curator: { curate },
      structuredPlaybookStore: createInMemoryStructuredPlaybookStore(),
      // No richTrajectorySource
    });

    const pipeline = createLlmPipeline(config);
    const buffer = createTrajectoryBuffer(100);

    await pipeline.consolidate([makeEntry()], "no-rich", 1, () => 2000, buffer);

    expect(analyze).toHaveBeenCalledTimes(1);
    const analyzeInput = analyze.mock.calls[0]?.[0] as
      | { readonly richTrajectory?: readonly RichTrajectoryStep[] }
      | undefined;
    expect(analyzeInput?.richTrajectory).toBeUndefined();
  });

  test("richTrajectorySource returning empty array skips store operations", async () => {
    const analyze = mock((_: unknown) =>
      Promise.resolve({ rootCause: "", keyInsight: "", bulletTags: [] as const }),
    );
    const curate = mock(() => Promise.resolve([]));
    const richTrajectorySource = mock(() => Promise.resolve([]));
    const richTrajectoryStore = createInMemoryRichTrajectoryStore();

    const config = makeMinimalConfig({
      reflector: { analyze },
      curator: { curate },
      structuredPlaybookStore: createInMemoryStructuredPlaybookStore(),
      richTrajectorySource,
      richTrajectoryStore,
    });

    const pipeline = createLlmPipeline(config);
    const buffer = createTrajectoryBuffer(100);

    await pipeline.consolidate([makeEntry()], "empty-rich", 1, () => 2000, buffer);

    // Store should not have any data appended
    const stored = await richTrajectoryStore.getSession("empty-rich");
    expect(stored).toHaveLength(0);

    // Reflector should still be called but with undefined richTrajectory
    const analyzeInput = analyze.mock.calls[0]?.[0] as
      | { readonly richTrajectory?: readonly RichTrajectoryStep[] }
      | undefined;
    expect(analyzeInput?.richTrajectory).toBeUndefined();
  });
});
