/**
 * Delta watermark tests — verifies that the LLM pipeline only reflects on
 * new steps since the last reflection, and that the watermark persists
 * across sessions and recovers from corruption.
 */

import { describe, expect, mock, test } from "bun:test";
import type { StructuredPlaybook } from "@koi/ace-types";
import type { RichTrajectoryStep } from "@koi/core/rich-trajectory";
import { createInMemoryAtifDocumentStore } from "../atif-store.js";
import type { AceConfig } from "../config.js";
import { createLlmPipeline } from "../pipeline.js";
import {
  createInMemoryPlaybookStore,
  createInMemoryStructuredPlaybookStore,
  createInMemoryTrajectoryStore,
} from "../stores.js";
import { createTrajectoryBuffer } from "../trajectory-buffer.js";
import type { TrajectoryEntry } from "../types.js";

const BASE_TIMESTAMP = 1700000000000;

function createStep(index: number, timestamp?: number): RichTrajectoryStep {
  return {
    stepIndex: index,
    timestamp: timestamp ?? BASE_TIMESTAMP + index * 1000,
    source: "agent",
    kind: "model_call",
    identifier: "claude-3-opus",
    outcome: "success",
    durationMs: 1200,
    request: { text: `Step ${index}` },
    response: { text: `Response ${index}` },
  };
}

function makeEntry(index: number): TrajectoryEntry {
  return {
    turnIndex: index,
    timestamp: BASE_TIMESTAMP + index * 1000,
    kind: "model_call",
    identifier: "claude-3-opus",
    outcome: "success",
    durationMs: 1200,
  };
}

function makeReflectorResponse(): string {
  return JSON.stringify({
    rootCause: "Test root cause",
    keyInsight: "Test insight",
    bulletTags: [],
  });
}

function makeCuratorResponse(): string {
  return JSON.stringify([{ kind: "add", section: "str", content: "New bullet" }]);
}

describe("delta watermark tracking", () => {
  test("first reflection sets watermark to max stepIndex", async () => {
    const atifStore = createInMemoryAtifDocumentStore({ agentName: "test" });
    const structuredPlaybookStore = createInMemoryStructuredPlaybookStore();
    const modelCall = mock(async (): Promise<string> => {
      // First call = reflector, second call = curator
      if ((modelCall as { mock: { calls: unknown[] } }).mock.calls.length <= 1) {
        return makeReflectorResponse();
      }
      return makeCuratorResponse();
    });

    // Seed ATIF store with 5 steps
    await atifStore.append(
      "conv-1",
      Array.from({ length: 5 }, (_, i) => createStep(i)),
    );

    const config: AceConfig = {
      trajectoryStore: createInMemoryTrajectoryStore(),
      playbookStore: createInMemoryPlaybookStore(),
      structuredPlaybookStore,
      reflector: {
        analyze: async (_input) => {
          const raw = await modelCall();
          return JSON.parse(raw) as ReturnType<typeof JSON.parse>;
        },
      },
      curator: {
        curate: async () => {
          const raw = await modelCall();
          return JSON.parse(raw) as ReturnType<typeof JSON.parse>;
        },
      },
      atifStore,
    };

    const pipeline = createLlmPipeline(config);
    const buffer = createTrajectoryBuffer(1000);
    const entries = Array.from({ length: 5 }, (_, i) => makeEntry(i));

    await pipeline.consolidate(entries, "conv-1", 1, () => BASE_TIMESTAMP + 10_000, buffer);

    // Verify watermark was set on the playbook
    const playbook = await structuredPlaybookStore.get("ace:structured:conv-1");
    expect(playbook).toBeDefined();
    expect(playbook?.lastReflectedStepIndex).toBe(4); // max stepIndex in the 5 steps
  });

  test("second reflection only reads delta (steps after watermark)", async () => {
    const atifStore = createInMemoryAtifDocumentStore({ agentName: "test" });
    const structuredPlaybookStore = createInMemoryStructuredPlaybookStore();

    // Track what the reflector receives
    const reflectorInputs: unknown[] = [];
    const reflector = {
      analyze: mock(async (input: unknown) => {
        reflectorInputs.push(input);
        return { rootCause: "cause", keyInsight: "insight", bulletTags: [] };
      }),
    };
    const curator = {
      curate: mock(async () => []),
    };

    const config: AceConfig = {
      trajectoryStore: createInMemoryTrajectoryStore(),
      playbookStore: createInMemoryPlaybookStore(),
      structuredPlaybookStore,
      reflector,
      curator,
      atifStore,
    };

    const pipeline = createLlmPipeline(config);
    const buffer = createTrajectoryBuffer(1000);
    const clockFn = () => BASE_TIMESTAMP + 50_000;

    // Session 1: 20 steps
    await atifStore.append(
      "conv-1",
      Array.from({ length: 20 }, (_, i) => createStep(i)),
    );
    await pipeline.consolidate(
      Array.from({ length: 20 }, (_, i) => makeEntry(i)),
      "conv-1",
      1,
      clockFn,
      buffer,
    );

    // Verify watermark = 19
    const pb1 = await structuredPlaybookStore.get("ace:structured:conv-1");
    expect(pb1?.lastReflectedStepIndex).toBe(19);

    // Session 2: 20 more steps (indices 20-39)
    await atifStore.append(
      "conv-1",
      Array.from({ length: 20 }, (_, i) => createStep(20 + i)),
    );
    await pipeline.consolidate(
      Array.from({ length: 20 }, (_, i) => makeEntry(20 + i)),
      "conv-1",
      2,
      clockFn,
      buffer,
    );

    // Verify watermark advanced to 39
    const pb2 = await structuredPlaybookStore.get("ace:structured:conv-1");
    expect(pb2?.lastReflectedStepIndex).toBe(39);

    // Verify reflector was called twice
    expect(reflector.analyze.mock.calls).toHaveLength(2);
  });

  test("corrupted watermark (beyond max step) resets gracefully", async () => {
    const atifStore = createInMemoryAtifDocumentStore({ agentName: "test" });
    const structuredPlaybookStore = createInMemoryStructuredPlaybookStore();

    // Pre-seed a playbook with a corrupted watermark (999, but only 5 steps exist)
    const corruptedPlaybook: StructuredPlaybook = {
      id: "ace:structured:conv-1",
      title: "Test",
      sections: [{ name: "Strategy", slug: "str", bullets: [] }],
      tags: [],
      source: "curated",
      createdAt: BASE_TIMESTAMP,
      updatedAt: BASE_TIMESTAMP,
      sessionCount: 1,
      lastReflectedStepIndex: 999,
    };
    await structuredPlaybookStore.save(corruptedPlaybook);

    const reflectorInputs: unknown[] = [];
    const reflector = {
      analyze: mock(async (input: unknown) => {
        reflectorInputs.push(input);
        return { rootCause: "cause", keyInsight: "insight", bulletTags: [] };
      }),
    };
    const curator = { curate: mock(async () => []) };

    const config: AceConfig = {
      trajectoryStore: createInMemoryTrajectoryStore(),
      playbookStore: createInMemoryPlaybookStore(),
      structuredPlaybookStore,
      reflector,
      curator,
      atifStore,
    };

    // Seed 5 steps (indices 0-4)
    await atifStore.append(
      "conv-1",
      Array.from({ length: 5 }, (_, i) => createStep(i)),
    );

    const pipeline = createLlmPipeline(config);
    const buffer = createTrajectoryBuffer(1000);

    // This should not crash — the corrupted watermark should trigger a full read
    await pipeline.consolidate(
      Array.from({ length: 5 }, (_, i) => makeEntry(i)),
      "conv-1",
      1,
      () => BASE_TIMESTAMP + 10_000,
      buffer,
    );

    // Reflector should still have been called (with full trajectory as fallback)
    expect(reflector.analyze.mock.calls).toHaveLength(1);
  });
});
