import { describe, expect, test } from "bun:test";

import { createOwnershipMap } from "../native-host/ownership-map.js";

describe("OwnershipMap", () => {
  test("set + get round-trip for committed phase", () => {
    const m = createOwnershipMap();
    m.set(42, {
      phase: "committed",
      clientId: "c1",
      sessionId: "s1",
      committingRequestId: "r1",
      since: 100,
    });
    expect(m.get(42)?.phase).toBe("committed");
    expect(m.size()).toBe(1);
  });

  test("set overwrites when phase transitions from committed → detaching_failed", () => {
    const m = createOwnershipMap();
    m.set(42, {
      phase: "committed",
      clientId: "c1",
      sessionId: "s1",
      committingRequestId: "r1",
      since: 100,
    });
    m.set(42, {
      phase: "detaching_failed",
      clientId: "c1",
      sessionId: "s1",
      reason: "chrome_error",
      since: 200,
    });
    expect(m.get(42)?.phase).toBe("detaching_failed");
  });

  test("delete returns true when present, false when absent", () => {
    const m = createOwnershipMap();
    m.set(42, {
      phase: "committed",
      clientId: "c1",
      sessionId: "s1",
      committingRequestId: "r1",
      since: 100,
    });
    expect(m.delete(42)).toBe(true);
    expect(m.delete(42)).toBe(false);
  });

  test("entries yields all pairs", () => {
    const m = createOwnershipMap();
    m.set(1, {
      phase: "committed",
      clientId: "c1",
      sessionId: "s1",
      committingRequestId: "r1",
      since: 100,
    });
    m.set(2, {
      phase: "detaching_failed",
      clientId: "c2",
      sessionId: "s2",
      reason: "timeout",
      since: 200,
    });
    const all = Array.from(m.entries());
    expect(all.length).toBe(2);
  });
});
