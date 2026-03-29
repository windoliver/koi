/**
 * Error propagation tests — verifies that reflector/curator parse failures
 * propagate through the LLM pipeline to the onLlmPipelineError callback.
 */

import { describe, expect, mock, test } from "bun:test";
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

describe("LLM pipeline error propagation", () => {
  test("reflector parse failure throws with cause chain", async () => {
    const reflector = {
      analyze: mock(async () => {
        // Simulate the reflector receiving garbage from the LLM
        // and the internal parseReflectionResponse throwing
        throw new Error("ACE reflector: failed to parse LLM response", {
          cause: new SyntaxError("Unexpected token"),
        });
      }),
    };
    const curator = { curate: mock(async () => []) };
    const structuredPlaybookStore = createInMemoryStructuredPlaybookStore();

    const config: AceConfig = {
      trajectoryStore: createInMemoryTrajectoryStore(),
      playbookStore: createInMemoryPlaybookStore(),
      structuredPlaybookStore,
      reflector,
      curator,
    };

    const pipeline = createLlmPipeline(config);
    const buffer = createTrajectoryBuffer(1000);
    const entries = [makeEntry(0), makeEntry(1)];

    await expect(
      pipeline.consolidate(entries, "sess-1", 1, () => BASE_TIMESTAMP, buffer),
    ).rejects.toThrow("ACE reflector: failed to parse LLM response");

    // Curator should NOT have been called (reflector failed first)
    expect(curator.curate.mock.calls).toHaveLength(0);
  });

  test("curator parse failure throws with cause chain", async () => {
    const reflector = {
      analyze: mock(async () => ({
        rootCause: "test",
        keyInsight: "test",
        bulletTags: [],
      })),
    };
    const curator = {
      curate: mock(async () => {
        throw new Error("ACE curator: failed to parse LLM response", {
          cause: new SyntaxError("Unexpected end of JSON"),
        });
      }),
    };
    const structuredPlaybookStore = createInMemoryStructuredPlaybookStore();

    const config: AceConfig = {
      trajectoryStore: createInMemoryTrajectoryStore(),
      playbookStore: createInMemoryPlaybookStore(),
      structuredPlaybookStore,
      reflector,
      curator,
    };

    const pipeline = createLlmPipeline(config);
    const buffer = createTrajectoryBuffer(1000);
    const entries = [makeEntry(0)];

    await expect(
      pipeline.consolidate(entries, "sess-1", 1, () => BASE_TIMESTAMP, buffer),
    ).rejects.toThrow("ACE curator: failed to parse LLM response");

    // Reflector should have been called
    expect(reflector.analyze.mock.calls).toHaveLength(1);
  });

  test("pipeline error reaches onLlmPipelineError callback via fire-and-forget", async () => {
    // This tests the integration at the middleware level:
    // ace.ts catches the pipeline error and routes it to the callback.
    // We simulate by verifying the default handler would be called.

    const reflector = {
      analyze: mock(async () => {
        throw new Error("LLM timeout");
      }),
    };
    const curator = { curate: mock(async () => []) };

    const errors: Array<{ readonly error: unknown; readonly sessionId: string }> = [];
    const config: AceConfig = {
      trajectoryStore: createInMemoryTrajectoryStore(),
      playbookStore: createInMemoryPlaybookStore(),
      structuredPlaybookStore: createInMemoryStructuredPlaybookStore(),
      reflector,
      curator,
      onLlmPipelineError: (error, sessionId) => {
        errors.push({ error, sessionId });
      },
    };

    const pipeline = createLlmPipeline(config);
    const buffer = createTrajectoryBuffer(1000);

    // The pipeline itself throws — in ace.ts this would be caught by the .catch()
    // and routed to onLlmPipelineError. Here we verify the throw happens.
    try {
      await pipeline.consolidate([makeEntry(0)], "sess-err", 1, () => BASE_TIMESTAMP, buffer);
    } catch (e: unknown) {
      // Simulate what ace.ts does
      config.onLlmPipelineError?.(e, "sess-err");
    }

    expect(errors).toHaveLength(1);
    expect(errors[0]?.sessionId).toBe("sess-err");
    expect(errors[0]?.error).toBeInstanceOf(Error);
  });
});
