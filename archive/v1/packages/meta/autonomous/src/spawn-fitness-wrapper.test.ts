/**
 * Tests for spawn fitness wrapper.
 */

import { describe, expect, it, mock } from "bun:test";
import type { AgentManifest } from "@koi/core";

import {
  createSpawnFitnessWrapper,
  embedBrickId,
  type SpawnHealthRecorder,
} from "./spawn-fitness-wrapper.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_MANIFEST: AgentManifest = {
  name: "test-agent",
  version: "0.0.1",
  model: { name: "mock" },
};

function manifestWithBrickId(brickId: string): AgentManifest {
  return embedBrickId(BASE_MANIFEST, brickId);
}

interface TestRequest {
  readonly manifest: AgentManifest;
  readonly description: string;
}

type TestResult =
  | { readonly ok: true; readonly output: string }
  | { readonly ok: false; readonly error: string };

function createRecorder(): SpawnHealthRecorder & {
  readonly successCalls: Array<{ readonly id: string; readonly latencyMs: number }>;
  readonly failureCalls: Array<{
    readonly id: string;
    readonly latencyMs: number;
    readonly error: string;
  }>;
} {
  const successCalls: Array<{ readonly id: string; readonly latencyMs: number }> = [];
  const failureCalls: Array<{
    readonly id: string;
    readonly latencyMs: number;
    readonly error: string;
  }> = [];
  return {
    successCalls,
    failureCalls,
    recordSuccess: mock((id: string, latencyMs: number) => {
      successCalls.push({ id, latencyMs });
    }),
    recordFailure: mock((id: string, latencyMs: number, error: string) => {
      failureCalls.push({ id, latencyMs, error });
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSpawnFitnessWrapper", () => {
  it("records success with correct brickId and timing", async () => {
    const recorder = createRecorder();
    // eslint-disable-next-line no-restricted-syntax -- justified: mutable clock for testing
    let now = 1000;
    const spawn = mock(async (_req: TestRequest): Promise<TestResult> => {
      now += 250; // simulate 250ms of work
      return { ok: true, output: "done" };
    });

    const wrapped = createSpawnFitnessWrapper<TestRequest, TestResult>(spawn, {
      healthRecorder: recorder,
      clock: () => now,
    });

    const result = await wrapped({
      manifest: manifestWithBrickId("brick_abc"),
      description: "do work",
    });

    expect(result).toEqual({ ok: true, output: "done" });
    expect(recorder.successCalls).toHaveLength(1);
    expect(recorder.successCalls[0]?.id).toBe("brick_abc");
    expect(recorder.successCalls[0]?.latencyMs).toBe(250);
    expect(recorder.failureCalls).toHaveLength(0);
  });

  it("records failure when spawn returns error result", async () => {
    const recorder = createRecorder();
    // eslint-disable-next-line no-restricted-syntax -- justified: mutable clock
    let now = 1000;
    const spawn = mock(async (_req: TestRequest): Promise<TestResult> => {
      now += 100;
      return { ok: false, error: "agent crashed" };
    });

    const wrapped = createSpawnFitnessWrapper<TestRequest, TestResult>(spawn, {
      healthRecorder: recorder,
      clock: () => now,
    });

    const result = await wrapped({
      manifest: manifestWithBrickId("brick_xyz"),
      description: "do work",
    });

    expect(result).toEqual({ ok: false, error: "agent crashed" });
    expect(recorder.failureCalls).toHaveLength(1);
    expect(recorder.failureCalls[0]?.id).toBe("brick_xyz");
    expect(recorder.failureCalls[0]?.latencyMs).toBe(100);
    expect(recorder.failureCalls[0]?.error).toBe("agent crashed");
    expect(recorder.successCalls).toHaveLength(0);
  });

  it("records failure when spawn throws", async () => {
    const recorder = createRecorder();
    // eslint-disable-next-line no-restricted-syntax -- justified: mutable clock
    let now = 1000;
    const spawn = mock(async (_req: TestRequest): Promise<TestResult> => {
      now += 50;
      throw new Error("network timeout");
    });

    const wrapped = createSpawnFitnessWrapper<TestRequest, TestResult>(spawn, {
      healthRecorder: recorder,
      clock: () => now,
    });

    await expect(
      wrapped({ manifest: manifestWithBrickId("brick_err"), description: "do work" }),
    ).rejects.toThrow("network timeout");

    expect(recorder.failureCalls).toHaveLength(1);
    expect(recorder.failureCalls[0]?.id).toBe("brick_err");
    expect(recorder.failureCalls[0]?.latencyMs).toBe(50);
    expect(recorder.failureCalls[0]?.error).toBe("network timeout");
  });

  it("skips recording when no brickId in metadata", async () => {
    const recorder = createRecorder();
    const spawn = mock(async (_req: TestRequest): Promise<TestResult> => {
      return { ok: true, output: "done" };
    });

    const wrapped = createSpawnFitnessWrapper<TestRequest, TestResult>(spawn, {
      healthRecorder: recorder,
    });

    // No brickId embedded — static map agent
    const result = await wrapped({
      manifest: BASE_MANIFEST,
      description: "do work",
    });

    expect(result).toEqual({ ok: true, output: "done" });
    expect(recorder.successCalls).toHaveLength(0);
    expect(recorder.failureCalls).toHaveLength(0);
  });

  it("passes request through unchanged", async () => {
    const recorder = createRecorder();
    const spawn = mock(async (req: TestRequest): Promise<TestResult> => {
      return { ok: true, output: req.description };
    });

    const wrapped = createSpawnFitnessWrapper<TestRequest, TestResult>(spawn, {
      healthRecorder: recorder,
    });

    const result = await wrapped({
      manifest: manifestWithBrickId("brick_pass"),
      description: "hello world",
    });

    expect(result).toEqual({ ok: true, output: "hello world" });
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe("embedBrickId", () => {
  it("embeds brickId into manifest metadata", () => {
    const manifest = embedBrickId(BASE_MANIFEST, "brick_123");
    const metadata = manifest.metadata as Readonly<Record<string, unknown>>;
    expect(metadata.__brickId).toBe("brick_123");
  });

  it("preserves existing metadata", () => {
    const existing: AgentManifest = {
      ...BASE_MANIFEST,
      metadata: { custom: "value" },
    };
    const manifest = embedBrickId(existing, "brick_456");
    const metadata = manifest.metadata as Readonly<Record<string, unknown>>;
    expect(metadata.__brickId).toBe("brick_456");
    expect(metadata.custom).toBe("value");
  });

  it("does not mutate original manifest", () => {
    const original = { ...BASE_MANIFEST };
    const result = embedBrickId(original, "brick_789");
    expect(original.metadata).toBeUndefined();
    expect(result.metadata).toBeDefined();
  });
});
