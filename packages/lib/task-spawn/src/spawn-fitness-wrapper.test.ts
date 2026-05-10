import { describe, expect, mock, test } from "bun:test";
import type { KoiError, SpawnRequest, SpawnResult } from "@koi/core";

import { createSpawnFitnessWrapper, type SpawnFitnessOutcome } from "./spawn-fitness-wrapper.js";

function createRequest(overrides: Partial<SpawnRequest> = {}): SpawnRequest {
  return {
    description: "do work",
    agentName: "worker",
    signal: new AbortController().signal,
    ...overrides,
  };
}

function createFailure(message: string): KoiError {
  return { code: "EXTERNAL", message, retryable: true };
}

describe("createSpawnFitnessWrapper", () => {
  test("records successful outcomes and returns the original result", async () => {
    const recordOutcome = mock(async (_outcome: SpawnFitnessOutcome) => undefined);
    let now = 10;
    const result: SpawnResult = { ok: true, output: "done" };
    const spawn = mock(async (_request: SpawnRequest): Promise<SpawnResult> => {
      now = 17;
      return result;
    });

    const wrapped = createSpawnFitnessWrapper(spawn, {
      recordOutcome,
      now: () => now,
    });

    const observed = await wrapped(createRequest());

    expect(observed).toBe(result);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(recordOutcome).toHaveBeenCalledTimes(1);
    expect(recordOutcome.mock.calls[0]?.[0]).toEqual({
      agentName: "worker",
      description: "do work",
      durationMs: 7,
      ok: true,
    });
  });

  test("records failed outcomes with the KoiError message and returns the original result", async () => {
    const recordOutcome = mock(async (_outcome: SpawnFitnessOutcome) => undefined);
    let now = 20;
    const result: SpawnResult = { ok: false, error: createFailure("boom") };
    const spawn = mock(async (_request: SpawnRequest): Promise<SpawnResult> => {
      now = 26;
      return result;
    });

    const wrapped = createSpawnFitnessWrapper(spawn, {
      recordOutcome,
      now: () => now,
    });

    const observed = await wrapped(createRequest({ description: "investigate" }));

    expect(observed).toBe(result);
    expect(recordOutcome).toHaveBeenCalledTimes(1);
    expect(recordOutcome.mock.calls[0]?.[0]).toEqual({
      agentName: "worker",
      description: "investigate",
      durationMs: 6,
      ok: false,
      error: "boom",
    });
  });

  test("swallows recorder failures so spawn behavior stays observational", async () => {
    const result: SpawnResult = { ok: true, output: "done" };
    const spawn = mock(async (_request: SpawnRequest): Promise<SpawnResult> => result);
    const wrapped = createSpawnFitnessWrapper(spawn, {
      recordOutcome: mock(async () => {
        throw new Error("recorder offline");
      }),
    });

    await expect(wrapped(createRequest())).resolves.toBe(result);
  });

  test("swallows synchronous recorder throws", async () => {
    const result: SpawnResult = { ok: true, output: "done" };
    const spawn = mock(async (_request: SpawnRequest): Promise<SpawnResult> => result);
    const wrapped = createSpawnFitnessWrapper(spawn, {
      recordOutcome: () => {
        throw new Error("recorder offline");
      },
    });

    await expect(wrapped(createRequest())).resolves.toBe(result);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  test("does not block spawn return on a hung recorder", async () => {
    const result: SpawnResult = { ok: true, output: "done" };
    const spawn = mock(async (_request: SpawnRequest): Promise<SpawnResult> => result);
    const recordOutcome = mock(
      (_outcome: SpawnFitnessOutcome) => new Promise<void>(() => undefined),
    );

    const wrapped = createSpawnFitnessWrapper(spawn, { recordOutcome });

    const observed = await wrapped(createRequest());

    expect(observed).toBe(result);
    expect(recordOutcome).toHaveBeenCalledTimes(1);
  });

  test("records failed outcomes when spawn throws and rethrows the original error", async () => {
    const recordOutcome = mock(async (_outcome: SpawnFitnessOutcome) => undefined);
    let now = 30;
    const thrown = new Error("spawn transport crashed");
    const spawn = mock(async (_request: SpawnRequest): Promise<SpawnResult> => {
      now = 39;
      throw thrown;
    });

    const wrapped = createSpawnFitnessWrapper(spawn, {
      recordOutcome,
      now: () => now,
    });

    await expect(wrapped(createRequest({ description: "recover task" }))).rejects.toBe(thrown);
    expect(recordOutcome).toHaveBeenCalledTimes(1);
    expect(recordOutcome.mock.calls[0]?.[0]).toEqual({
      agentName: "worker",
      description: "recover task",
      durationMs: 9,
      ok: false,
      error: "spawn transport crashed",
    });
  });
});
