import { describe, expect, test } from "bun:test";

import { createInFlightMap } from "../native-host/in-flight-map.js";

describe("InFlightMap", () => {
  test("composite key isolates same attachRequestId across clients", () => {
    const m = createInFlightMap();
    m.add({
      tabId: 42,
      clientId: "c1",
      attachRequestId: "r1",
      leaseToken: "a".repeat(32),
      receivedAt: 1,
      abandoned: false,
    });
    m.add({
      tabId: 42,
      clientId: "c2",
      attachRequestId: "r1",
      leaseToken: "b".repeat(32),
      receivedAt: 2,
      abandoned: false,
    });
    expect(m.get("c1", "r1")?.clientId).toBe("c1");
    expect(m.get("c2", "r1")?.clientId).toBe("c2");
    expect(m.size()).toBe(2);
  });

  test("markAbandonedByClient flips only matching entries", () => {
    const m = createInFlightMap();
    m.add({
      tabId: 42,
      clientId: "c1",
      attachRequestId: "r1",
      leaseToken: "a".repeat(32),
      receivedAt: 1,
      abandoned: false,
    });
    m.add({
      tabId: 42,
      clientId: "c1",
      attachRequestId: "r2",
      leaseToken: "b".repeat(32),
      receivedAt: 2,
      abandoned: false,
    });
    m.add({
      tabId: 43,
      clientId: "c2",
      attachRequestId: "r3",
      leaseToken: "c".repeat(32),
      receivedAt: 3,
      abandoned: false,
    });
    const abandoned = m.markAbandonedByClient("c1");
    expect(abandoned.length).toBe(2);
    expect(m.get("c1", "r1")?.abandoned).toBe(true);
    expect(m.get("c2", "r3")?.abandoned).toBe(false);
  });

  test("delete removes by composite key", () => {
    const m = createInFlightMap();
    m.add({
      tabId: 42,
      clientId: "c1",
      attachRequestId: "r1",
      leaseToken: "a".repeat(32),
      receivedAt: 1,
      abandoned: false,
    });
    expect(m.delete("c1", "r1")).toBe(true);
    expect(m.get("c1", "r1")).toBeUndefined();
  });

  test("entriesForTab filters out abandoned", () => {
    const m = createInFlightMap();
    m.add({
      tabId: 42,
      clientId: "c1",
      attachRequestId: "r1",
      leaseToken: "a".repeat(32),
      receivedAt: 1,
      abandoned: false,
    });
    m.add({
      tabId: 42,
      clientId: "c2",
      attachRequestId: "r2",
      leaseToken: "b".repeat(32),
      receivedAt: 2,
      abandoned: false,
    });
    m.markAbandonedByClient("c1");
    const live = m.entriesForTab(42);
    expect(live.length).toBe(1);
    expect(live[0]?.clientId).toBe("c2");
  });

  test("markAbandonedByClient is idempotent", () => {
    const m = createInFlightMap();
    m.add({
      tabId: 42,
      clientId: "c1",
      attachRequestId: "r1",
      leaseToken: "a".repeat(32),
      receivedAt: 1,
      abandoned: false,
    });
    expect(m.markAbandonedByClient("c1").length).toBe(1);
    expect(m.markAbandonedByClient("c1").length).toBe(0);
  });
});
