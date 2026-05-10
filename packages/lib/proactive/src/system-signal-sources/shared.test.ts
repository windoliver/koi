import { describe, expect, test } from "bun:test";
import type { SystemSignal } from "@koi/core";
import {
  createAsyncEmitter,
  createSubscriptionController,
  matchesAnyPathFilter,
} from "./shared.js";

describe("createAsyncEmitter", () => {
  test("delivers signals asynchronously", async () => {
    const seen: string[] = [];
    const signal = {
      kind: "governance",
      sensor: "error_rate",
      value: 0.4,
      limit: 0.3,
      direction: "above",
      emittedAt: 1,
    } as const satisfies SystemSignal;

    const emitter = createAsyncEmitter((value) => seen.push(value.kind), {});

    emitter.emit(signal);
    expect(seen).toEqual([]);

    await Promise.resolve();
    expect(seen).toEqual(["governance"]);
  });

  test("throttles emissions when sampleRateMs is set", async () => {
    let now = 100;
    const seen: number[] = [];
    const emitter = createAsyncEmitter(
      (value) => {
        if ("emittedAt" in value) seen.push(value.emittedAt);
      },
      { sampleRateMs: 50 },
      () => now,
    );

    emitter.emit({ kind: "vfs", event: "write", path: "/a", emittedAt: 100 });
    await Promise.resolve();

    now = 120;
    emitter.emit({ kind: "vfs", event: "write", path: "/b", emittedAt: 120 });
    await Promise.resolve();

    now = 170;
    emitter.emit({ kind: "vfs", event: "write", path: "/c", emittedAt: 170 });

    await Promise.resolve();
    expect(seen).toEqual([100, 170]);
  });

  test("throttles based on actual handler delivery time", async () => {
    let now = 100;
    const seen: number[] = [];
    const emitter = createAsyncEmitter(
      (value) => {
        if (!("emittedAt" in value)) return;
        seen.push(value.emittedAt);
        if (value.emittedAt === 100) now = 140;
      },
      { sampleRateMs: 50 },
      () => now,
    );

    emitter.emit({ kind: "vfs", event: "write", path: "/a", emittedAt: 100 });

    await Promise.resolve();
    expect(seen).toEqual([100]);

    now = 160;
    emitter.emit({ kind: "vfs", event: "write", path: "/b", emittedAt: 160 });

    await Promise.resolve();
    expect(seen).toEqual([100]);

    now = 191;
    emitter.emit({ kind: "vfs", event: "write", path: "/c", emittedAt: 191 });

    await Promise.resolve();
    expect(seen).toEqual([100, 191]);
  });

  test("suppresses queued delivery when isClosed becomes true before microtask runs", async () => {
    const seen: string[] = [];
    let closed = false;
    const emitter = createAsyncEmitter(
      (value) => seen.push(value.kind),
      {},
      Date.now,
      () => closed,
    );

    emitter.emit({
      kind: "governance",
      sensor: "error_rate",
      value: 0.4,
      limit: 0.3,
      direction: "above",
      emittedAt: 1,
    });
    closed = true;

    await Promise.resolve();
    expect(seen).toEqual([]);
  });

  test("rejects emission entirely when already closed at emit time", async () => {
    const seen: string[] = [];
    const emitter = createAsyncEmitter(
      (value) => seen.push(value.kind),
      {},
      Date.now,
      () => true,
    );

    emitter.emit({
      kind: "governance",
      sensor: "error_rate",
      value: 0.4,
      limit: 0.3,
      direction: "above",
      emittedAt: 1,
    });

    await Promise.resolve();
    expect(seen).toEqual([]);
  });
});

describe("createSubscriptionController", () => {
  test("unsubscribe is idempotent and disconnect fires once", () => {
    let closed = 0;
    const controller = createSubscriptionController(() => {
      closed += 1;
    });

    controller.unsubscribe();
    controller.unsubscribe();

    expect(closed).toBe(1);
    expect(controller.closed).toBe(true);
  });
});

describe("matchesAnyPathFilter", () => {
  test("treats missing filters as match-all", () => {
    expect(matchesAnyPathFilter("/tmp/file.txt", undefined)).toBe(true);
  });

  test("supports simple wildcard suffix matching", () => {
    expect(matchesAnyPathFilter("/workspace/docs/a.md", ["/workspace/docs/*"])).toBe(true);
    expect(matchesAnyPathFilter("/workspace/src/a.ts", ["/workspace/docs/*"])).toBe(false);
  });
});
