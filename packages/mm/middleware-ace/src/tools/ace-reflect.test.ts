import { describe, expect, mock, test } from "bun:test";
import type { JsonObject } from "@koi/core";
import type { TrajectoryDocumentStore } from "@koi/core/rich-trajectory";
import type { AceMiddlewareHandle } from "../ace.js";
import type { AtifWriteBehindBuffer } from "../atif-buffer.js";
import type { ConsolidationPipeline } from "../pipeline.js";
import { createInMemoryStructuredPlaybookStore } from "../stores.js";
import { createTrajectoryBuffer } from "../trajectory-buffer.js";
import { createAceReflectTool } from "./ace-reflect.js";

function createMockBuffer(): AtifWriteBehindBuffer {
  return {
    append: mock(() => {}),
    flush: mock(async () => {}),
    pending: mock(() => 0),
    dispose: mock(() => {}),
  };
}

function createMockStore(): TrajectoryDocumentStore {
  return {
    append: mock(async () => {}),
    getDocument: mock(async () => []),
    getStepRange: mock(async () => []),
    getSize: mock(async () => 0),
    prune: mock(async () => 0),
  };
}

function createMockPipeline(): ConsolidationPipeline {
  return {
    consolidate: mock(async () => {}),
  };
}

function createMockHandle(): AceMiddlewareHandle {
  return {
    middleware: { name: "ace", priority: 350, describeCapabilities: () => undefined },
    invalidatePlaybookCache: mock(() => {}),
  };
}

describe("createAceReflectTool", () => {
  test("returns queued on first call", async () => {
    const tool = createAceReflectTool({
      atifBuffer: createMockBuffer(),
      llmPipeline: createMockPipeline(),
      structuredPlaybookStore: createInMemoryStructuredPlaybookStore(),
      atifStore: createMockStore(),
      aceHandle: createMockHandle(),
      trajectoryBuffer: createTrajectoryBuffer(1000),
      conversationId: "conv-1",
      clock: () => 1000,
    });

    const result = await tool.execute({ reason: "testing" } as JsonObject);
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(parsed.status).toBe("queued");
    expect(parsed.reason).toBe("testing");
  });

  test("returns skipped when reflection is in-flight", async () => {
    const slowPipeline: ConsolidationPipeline = {
      consolidate: mock(async () => {
        // Simulate slow reflection
        await new Promise((resolve) => setTimeout(resolve, 500));
      }),
    };

    const tool = createAceReflectTool({
      atifBuffer: createMockBuffer(),
      llmPipeline: slowPipeline,
      structuredPlaybookStore: createInMemoryStructuredPlaybookStore(),
      atifStore: createMockStore(),
      aceHandle: createMockHandle(),
      trajectoryBuffer: createTrajectoryBuffer(1000),
      conversationId: "conv-1",
      clock: () => 1000,
    });

    // First call — accepted
    const result1 = await tool.execute({} as JsonObject);
    expect(JSON.parse(result1.content).status).toBe("queued");

    // Second call immediately — should be skipped (in-flight)
    const result2 = await tool.execute({} as JsonObject);
    expect(JSON.parse(result2.content).status).toBe("skipped");
    expect(JSON.parse(result2.content).reason).toBe("reflection already in progress");
  });

  test("returns skipped during cooldown period", async () => {
    // let: track current time for the clock mock
    let now = 1000;
    const tool = createAceReflectTool({
      atifBuffer: createMockBuffer(),
      llmPipeline: createMockPipeline(),
      structuredPlaybookStore: createInMemoryStructuredPlaybookStore(),
      atifStore: createMockStore(),
      aceHandle: createMockHandle(),
      trajectoryBuffer: createTrajectoryBuffer(1000),
      conversationId: "conv-1",
      cooldownMs: 5000,
      cooldownSteps: 3,
      clock: () => now,
    });

    // First call — accepted
    const result1 = await tool.execute({} as JsonObject);
    expect(JSON.parse(result1.content).status).toBe("queued");

    // Wait for async reflection to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 2 seconds later, 0 steps — both cooldown conditions active
    now = 3000;
    const result2 = await tool.execute({} as JsonObject);
    const parsed = JSON.parse(result2.content) as Record<string, unknown>;
    expect(parsed.status).toBe("skipped");
    expect(parsed.reason).toBe("cooldown active");
  });

  test("flushes buffer before reflection reads", async () => {
    const buffer = createMockBuffer();
    const tool = createAceReflectTool({
      atifBuffer: buffer,
      llmPipeline: createMockPipeline(),
      structuredPlaybookStore: createInMemoryStructuredPlaybookStore(),
      atifStore: createMockStore(),
      aceHandle: createMockHandle(),
      trajectoryBuffer: createTrajectoryBuffer(1000),
      conversationId: "conv-1",
      clock: () => 1000,
    });

    await tool.execute({} as JsonObject);

    // Wait for async reflection to start
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(buffer.flush).toHaveBeenCalledWith("conv-1");
  });

  test("invalidates playbook cache after successful reflection", async () => {
    const handle = createMockHandle();
    const tool = createAceReflectTool({
      atifBuffer: createMockBuffer(),
      llmPipeline: createMockPipeline(),
      structuredPlaybookStore: createInMemoryStructuredPlaybookStore(),
      atifStore: createMockStore(),
      aceHandle: handle,
      trajectoryBuffer: createTrajectoryBuffer(1000),
      conversationId: "conv-1",
      clock: () => 1000,
    });

    await tool.execute({} as JsonObject);

    // Wait for async reflection to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(handle.invalidatePlaybookCache).toHaveBeenCalled();
  });

  test("calls onReflectionError when pipeline fails", async () => {
    const errors: unknown[] = [];
    const failingPipeline: ConsolidationPipeline = {
      consolidate: mock(async () => {
        throw new Error("Pipeline boom");
      }),
    };

    const tool = createAceReflectTool({
      atifBuffer: createMockBuffer(),
      llmPipeline: failingPipeline,
      structuredPlaybookStore: createInMemoryStructuredPlaybookStore(),
      atifStore: createMockStore(),
      aceHandle: createMockHandle(),
      trajectoryBuffer: createTrajectoryBuffer(1000),
      conversationId: "conv-1",
      clock: () => 1000,
      onReflectionError: (e) => errors.push(e),
    });

    await tool.execute({} as JsonObject);

    // Wait for async error
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
  });

  test("tool descriptor has correct name and tags", () => {
    const tool = createAceReflectTool({
      atifBuffer: createMockBuffer(),
      llmPipeline: createMockPipeline(),
      structuredPlaybookStore: createInMemoryStructuredPlaybookStore(),
      atifStore: createMockStore(),
      aceHandle: createMockHandle(),
      trajectoryBuffer: createTrajectoryBuffer(1000),
      conversationId: "conv-1",
    });

    expect(tool.descriptor.name).toBe("ace_reflect");
    expect(tool.descriptor.tags).toContain("ace");
    expect(tool.descriptor.tags).toContain("reflection");
  });
});
