import { describe, expect, test } from "bun:test";
import { createSoftDenyLog } from "../soft-deny-log.js";

describe("SoftDenyLog (#1650 — internal, isolated from DenialTracker)", () => {
  test("records entries and returns them via getAll (oldest first)", () => {
    const log = createSoftDenyLog();
    log.record({ toolId: "bash", reason: "r1", timestamp: 1, principal: "a", turnIndex: 0 });
    log.record({ toolId: "write_file", reason: "r2", timestamp: 2, principal: "a", turnIndex: 0 });
    const all = log.getAll();
    expect(all.length).toBe(2);
    expect(all[0]?.toolId).toBe("bash");
    expect(all[1]?.toolId).toBe("write_file");
  });

  test("getByTool filters correctly", () => {
    const log = createSoftDenyLog();
    log.record({ toolId: "bash", reason: "x", timestamp: 1, principal: "a", turnIndex: 0 });
    log.record({ toolId: "write_file", reason: "x", timestamp: 2, principal: "a", turnIndex: 0 });
    expect(log.getByTool("bash").length).toBe(1);
    expect(log.getByTool("write_file").length).toBe(1);
    expect(log.getByTool("unknown").length).toBe(0);
  });

  test("FIFO eviction at maxEntries", () => {
    const log = createSoftDenyLog(2);
    log.record({ toolId: "a", reason: "r", timestamp: 1, principal: "p", turnIndex: 0 });
    log.record({ toolId: "b", reason: "r", timestamp: 2, principal: "p", turnIndex: 0 });
    log.record({ toolId: "c", reason: "r", timestamp: 3, principal: "p", turnIndex: 0 });
    const all = log.getAll();
    expect(all.length).toBe(2);
    expect(all[0]?.toolId).toBe("b");
    expect(all[1]?.toolId).toBe("c");
  });

  test("clear() empties the log", () => {
    const log = createSoftDenyLog();
    log.record({ toolId: "a", reason: "r", timestamp: 1, principal: "p", turnIndex: 0 });
    log.clear();
    expect(log.getAll().length).toBe(0);
  });
});
