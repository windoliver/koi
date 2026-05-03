import { describe, expect, test } from "bun:test";
import type { SignalSource, UserSignal } from "@koi/core";
import { readSignalSources } from "./signal-reader.js";

const okSource: SignalSource = {
  name: "ide",
  read: (): UserSignal => ({ kind: "sensor", source: "ide", values: { ok: true } }),
};

const slowSource: SignalSource = {
  name: "slow",
  read: (): Promise<UserSignal> =>
    new Promise((resolve) =>
      setTimeout(() => resolve({ kind: "sensor", source: "slow", values: { late: true } }), 500),
    ),
};

const failingSource: SignalSource = {
  name: "broken",
  read: (): Promise<UserSignal> => Promise.reject(new Error("offline")),
};

const malicious: SignalSource = {
  name: "malicious",
  read: (): UserSignal => ({ kind: "post_action", correction: "evil", source: "explicit" }),
};

describe("readSignalSources", () => {
  test("returns all signals from healthy sources", async () => {
    const out = await readSignalSources([okSource], 100, () => {});
    expect(out.signals.length).toBe(1);
    expect(out.signals[0]?.signal.kind).toBe("sensor");
    expect(out.signals[0]?.sourceName).toBe("ide");
    expect(out.failedSources).toEqual([]);
  });

  test("skips a source that throws and reports it as failed", async () => {
    const errors: unknown[] = [];
    const out = await readSignalSources([failingSource, okSource], 100, (e) => {
      errors.push(e);
    });
    expect(out.signals.length).toBe(1);
    expect(out.failedSources).toEqual(["broken"]);
    expect(errors.length).toBe(1);
  });

  test("skips a source that exceeds the timeout and reports it as failed", async () => {
    const errors: unknown[] = [];
    const out = await readSignalSources([slowSource, okSource], 50, (e) => {
      errors.push(e);
    });
    expect(out.signals.length).toBe(1);
    expect(out.failedSources).toEqual(["slow"]);
    expect(errors.length).toBe(1);
  });

  test("rejects non-sensor UserSignal kinds at the boundary", async () => {
    const errors: unknown[] = [];
    const out = await readSignalSources([malicious, okSource], 100, (e) => {
      errors.push(e);
    });
    expect(out.signals.length).toBe(1);
    const first = out.signals[0];
    if (first === undefined) throw new Error("expected one signal");
    expect(first.signal.source).toBe("ide");
    expect(first.sourceName).toBe("ide");
    expect(out.failedSources).toEqual(["malicious"]);
    expect(errors.length).toBe(1);
  });

  test("returns empty result when no sources are configured", async () => {
    const out = await readSignalSources([], 100, () => {});
    expect(out.signals).toEqual([]);
    expect(out.failedSources).toEqual([]);
  });
});
