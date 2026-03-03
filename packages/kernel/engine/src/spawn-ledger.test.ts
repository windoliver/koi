/**
 * Tests for InMemorySpawnLedger — tree-wide spawn accounting.
 *
 * TDD: these tests are written FIRST, before the implementation.
 */

import { describe, expect, test } from "bun:test";
import { createInMemorySpawnLedger } from "./spawn-ledger.js";

describe("createInMemorySpawnLedger", () => {
  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  test("returns a SpawnLedger with correct capacity", () => {
    const ledger = createInMemorySpawnLedger(10);
    expect(ledger.capacity()).toBe(10);
  });

  test("starts with activeCount of 0", () => {
    const ledger = createInMemorySpawnLedger(5);
    expect(ledger.activeCount()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Acquire
  // -------------------------------------------------------------------------

  test("acquire returns true when under capacity", () => {
    const ledger = createInMemorySpawnLedger(3);
    expect(ledger.acquire()).toBe(true);
    expect(ledger.activeCount()).toBe(1);
  });

  test("acquire increments activeCount each time", () => {
    const ledger = createInMemorySpawnLedger(5);
    ledger.acquire();
    ledger.acquire();
    ledger.acquire();
    expect(ledger.activeCount()).toBe(3);
  });

  test("acquire returns false when at capacity", () => {
    const ledger = createInMemorySpawnLedger(2);
    expect(ledger.acquire()).toBe(true); // 1
    expect(ledger.acquire()).toBe(true); // 2 = capacity
    expect(ledger.acquire()).toBe(false); // rejected
    expect(ledger.activeCount()).toBe(2); // unchanged
  });

  test("acquire returns false when capacity is 0", () => {
    const ledger = createInMemorySpawnLedger(0);
    expect(ledger.acquire()).toBe(false);
    expect(ledger.activeCount()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Release
  // -------------------------------------------------------------------------

  test("release decrements activeCount", () => {
    const ledger = createInMemorySpawnLedger(5);
    ledger.acquire();
    ledger.acquire();
    expect(ledger.activeCount()).toBe(2);

    ledger.release();
    expect(ledger.activeCount()).toBe(1);
  });

  test("release never goes below 0", () => {
    const ledger = createInMemorySpawnLedger(5);
    ledger.release(); // release without acquire
    expect(ledger.activeCount()).toBe(0);
  });

  test("release enables subsequent acquire after hitting capacity", () => {
    const ledger = createInMemorySpawnLedger(2);
    ledger.acquire(); // 1
    ledger.acquire(); // 2 = capacity
    expect(ledger.acquire()).toBe(false); // rejected

    ledger.release(); // back to 1
    expect(ledger.acquire()).toBe(true); // now succeeds
    expect(ledger.activeCount()).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Acquire-release cycling (map-reduce pattern)
  // -------------------------------------------------------------------------

  test("supports acquire-release cycling beyond capacity", () => {
    const ledger = createInMemorySpawnLedger(2);

    // Spawn 2, complete both, spawn 2 more — should work
    ledger.acquire(); // 1
    ledger.acquire(); // 2
    ledger.release(); // 1
    ledger.release(); // 0
    ledger.acquire(); // 1
    ledger.acquire(); // 2
    expect(ledger.activeCount()).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Multiple releases (idempotency / defensive)
  // -------------------------------------------------------------------------

  test("multiple releases from 1 only decrement to 0", () => {
    const ledger = createInMemorySpawnLedger(5);
    ledger.acquire(); // 1
    ledger.release(); // 0
    ledger.release(); // 0 (no-op, doesn't go negative)
    ledger.release(); // 0
    expect(ledger.activeCount()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Input validation
  // -------------------------------------------------------------------------

  test("throws on negative capacity", () => {
    expect(() => createInMemorySpawnLedger(-1)).toThrow("non-negative integer");
  });

  test("throws on non-integer capacity", () => {
    expect(() => createInMemorySpawnLedger(2.5)).toThrow("non-negative integer");
  });

  // -------------------------------------------------------------------------
  // Capacity is immutable
  // -------------------------------------------------------------------------

  test("capacity does not change after acquire or release", () => {
    const ledger = createInMemorySpawnLedger(10);
    ledger.acquire();
    ledger.acquire();
    ledger.release();
    expect(ledger.capacity()).toBe(10);
  });
});
