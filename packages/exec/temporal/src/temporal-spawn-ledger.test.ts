import { describe, expect, test } from "bun:test";
import { createTemporalSpawnLedger } from "./temporal-spawn-ledger.js";

describe("SpawnLedger contract", () => {
  test("acquire returns true when capacity available", () => {
    const ledger = createTemporalSpawnLedger({ maxCapacity: 3 });
    expect(ledger.acquire()).toBe(true);
    expect(ledger.activeCount()).toBe(1);
  });

  test("acquire returns false when at capacity", () => {
    const ledger = createTemporalSpawnLedger({ maxCapacity: 2 });
    expect(ledger.acquire()).toBe(true);
    expect(ledger.acquire()).toBe(true);
    expect(ledger.acquire()).toBe(false);
    expect(ledger.activeCount()).toBe(2);
  });

  test("release decrements active count", () => {
    const ledger = createTemporalSpawnLedger({ maxCapacity: 3 });
    ledger.acquire();
    ledger.acquire();
    expect(ledger.activeCount()).toBe(2);
    ledger.release();
    expect(ledger.activeCount()).toBe(1);
  });

  test("release does not go below zero", () => {
    const ledger = createTemporalSpawnLedger({ maxCapacity: 3 });
    ledger.release();
    expect(ledger.activeCount()).toBe(0);
  });

  test("acquire after release succeeds", () => {
    const ledger = createTemporalSpawnLedger({ maxCapacity: 1 });
    ledger.acquire();
    expect(ledger.acquire()).toBe(false);
    ledger.release();
    expect(ledger.acquire()).toBe(true);
  });

  test("capacity returns max capacity", () => {
    const ledger = createTemporalSpawnLedger({ maxCapacity: 42 });
    expect(ledger.capacity()).toBe(42);
  });

  test("capacity is immutable after creation", () => {
    const ledger = createTemporalSpawnLedger({ maxCapacity: 5 });
    ledger.acquire();
    ledger.acquire();
    expect(ledger.capacity()).toBe(5);
  });
});

describe("CAN recovery (initialActiveCount)", () => {
  test("restores active count from workflow state", () => {
    const ledger = createTemporalSpawnLedger({ maxCapacity: 10 }, 7);
    expect(ledger.activeCount()).toBe(7);
    expect(ledger.capacity()).toBe(10);
  });

  test("restored ledger respects capacity with existing count", () => {
    const ledger = createTemporalSpawnLedger({ maxCapacity: 3 }, 2);
    expect(ledger.acquire()).toBe(true);
    expect(ledger.acquire()).toBe(false);
  });

  test("default initial count is zero", () => {
    const ledger = createTemporalSpawnLedger({ maxCapacity: 5 });
    expect(ledger.activeCount()).toBe(0);
  });
});

describe("snapshot", () => {
  test("returns current state for workflow serialization", () => {
    const ledger = createTemporalSpawnLedger({ maxCapacity: 10 });
    ledger.acquire();
    ledger.acquire();
    const snap = ledger.snapshot();
    expect(snap.activeCount).toBe(2);
    expect(snap.capacity).toBe(10);
  });

  test("snapshot reflects release", () => {
    const ledger = createTemporalSpawnLedger({ maxCapacity: 10 });
    ledger.acquire();
    ledger.acquire();
    ledger.release();
    expect(ledger.snapshot().activeCount).toBe(1);
  });
});

describe("default config", () => {
  test("uses default capacity of 10", () => {
    const ledger = createTemporalSpawnLedger();
    expect(ledger.capacity()).toBe(10);
  });
});
