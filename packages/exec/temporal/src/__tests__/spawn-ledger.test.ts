import { describe, expect, test } from "bun:test";
import { createTemporalSpawnLedger, DEFAULT_SPAWN_LEDGER_CONFIG } from "../spawn-ledger.js";

describe("createTemporalSpawnLedger", () => {
  test("defaults: maxCapacity=10", () => {
    const ledger = createTemporalSpawnLedger();
    expect(ledger.capacity()).toBe(10);
    expect(ledger.activeCount()).toBe(0);
  });

  test("acquire increments activeCount", () => {
    const ledger = createTemporalSpawnLedger({ maxCapacity: 3 });
    expect(ledger.acquire()).toBe(true);
    expect(ledger.activeCount()).toBe(1);
  });

  test("acquire returns false at capacity", () => {
    const ledger = createTemporalSpawnLedger({ maxCapacity: 2 });
    expect(ledger.acquire()).toBe(true);
    expect(ledger.acquire()).toBe(true);
    expect(ledger.acquire()).toBe(false);
    expect(ledger.activeCount()).toBe(2);
  });

  test("release decrements activeCount", () => {
    const ledger = createTemporalSpawnLedger({ maxCapacity: 3 });
    ledger.acquire();
    ledger.acquire();
    ledger.release();
    expect(ledger.activeCount()).toBe(1);
  });

  test("release does not go below 0", () => {
    const ledger = createTemporalSpawnLedger({ maxCapacity: 3 });
    ledger.release();
    expect(ledger.activeCount()).toBe(0);
  });

  test("restores from initialActiveCount (Continue-As-New recovery)", () => {
    const ledger = createTemporalSpawnLedger({ maxCapacity: 5 }, 3);
    expect(ledger.activeCount()).toBe(3);
    expect(ledger.acquire()).toBe(true);
    expect(ledger.activeCount()).toBe(4);
  });

  test("snapshot reflects current state", () => {
    const ledger = createTemporalSpawnLedger({ maxCapacity: 5 }, 2);
    ledger.acquire();
    const snap = ledger.snapshot();
    expect(snap.activeCount).toBe(3);
    expect(snap.capacity).toBe(5);
  });

  test("capacity remains constant", () => {
    const ledger = createTemporalSpawnLedger({ maxCapacity: 7 });
    ledger.acquire();
    ledger.acquire();
    expect(ledger.capacity()).toBe(7);
  });

  test("invalid maxCapacity=0 throws", () => {
    expect(() => createTemporalSpawnLedger({ maxCapacity: 0 })).toThrow("maxCapacity");
  });

  test("invalid maxCapacity=-1 throws", () => {
    expect(() => createTemporalSpawnLedger({ maxCapacity: -1 })).toThrow("maxCapacity");
  });

  test("invalid maxCapacity=Infinity throws", () => {
    expect(() => createTemporalSpawnLedger({ maxCapacity: Infinity })).toThrow("maxCapacity");
  });

  test("oversized initialActiveCount clamped to maxCapacity", () => {
    const ledger = createTemporalSpawnLedger({ maxCapacity: 5 }, 99);
    expect(ledger.activeCount()).toBe(5);
    expect(ledger.acquire()).toBe(false); // already at capacity
  });

  test("negative initialActiveCount clamped to 0", () => {
    const ledger = createTemporalSpawnLedger({ maxCapacity: 5 }, -10);
    expect(ledger.activeCount()).toBe(0);
  });
});

describe("DEFAULT_SPAWN_LEDGER_CONFIG", () => {
  test("maxCapacity is 10", () => {
    expect(DEFAULT_SPAWN_LEDGER_CONFIG.maxCapacity).toBe(10);
  });
});
