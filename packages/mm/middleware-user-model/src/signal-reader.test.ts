import { describe, expect, test } from "bun:test";
import type { SignalSource, UserSignal } from "@koi/core/user-model";
import { readSignalSources } from "./signal-reader.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSensorSource(name: string, values: Record<string, unknown>): SignalSource {
  return {
    name,
    read: () => ({ kind: "sensor", source: name, values }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("readSignalSources", () => {
  test("returns empty when no sources", async () => {
    const result = await readSignalSources([], 200);
    expect(result.signals).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  test("reads multiple sources in parallel", async () => {
    const source1 = createSensorSource("s1", { a: 1 });
    const source2 = createSensorSource("s2", { b: 2 });

    const result = await readSignalSources([source1, source2], 200);
    expect(result.signals).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
  });

  test("source throws → skipped, other sources still read", async () => {
    const good = createSensorSource("good", { ok: true });
    const bad: SignalSource = {
      name: "bad",
      read: () => {
        throw new Error("boom");
      },
    };

    const result = await readSignalSources([good, bad], 200);
    expect(result.signals).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.source).toBe("bad");
    expect(result.errors[0]?.reason).toBe("error");
  });

  test("source returns malformed data → validated and discarded", async () => {
    const malformed: SignalSource = {
      name: "malformed",
      read: () => ({ bad: "data" }) as unknown as UserSignal,
    };

    const result = await readSignalSources([malformed], 200);
    expect(result.signals).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.reason).toBe("malformed");
  });

  test("source exceeds timeout → skipped with timeout error", async () => {
    const slow: SignalSource = {
      name: "slow",
      read: () =>
        new Promise<UserSignal>((resolve) => {
          setTimeout(() => {
            resolve({ kind: "sensor", source: "slow", values: {} });
          }, 500);
        }),
    };

    const result = await readSignalSources([slow], 50);
    expect(result.signals).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.reason).toBe("timeout");
  });

  test("all sources fail → empty signals, errors collected", async () => {
    const bad1: SignalSource = {
      name: "b1",
      read: () => {
        throw new Error("fail1");
      },
    };
    const bad2: SignalSource = {
      name: "b2",
      read: () => {
        throw new Error("fail2");
      },
    };

    const result = await readSignalSources([bad1, bad2], 200);
    expect(result.signals).toHaveLength(0);
    expect(result.errors).toHaveLength(2);
  });
});
