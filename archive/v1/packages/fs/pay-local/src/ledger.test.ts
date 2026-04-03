import { describe, expect, test } from "bun:test";
import { runPayLedgerContractTests } from "@koi/test-utils";
import { createLocalPayLedger } from "./ledger.js";

// ---------------------------------------------------------------------------
// Contract test suite — shared across all PayLedger implementations
// ---------------------------------------------------------------------------

runPayLedgerContractTests(() =>
  createLocalPayLedger({ initialBudget: "1000", agentId: "agent-1" }),
);

// ---------------------------------------------------------------------------
// Local-specific unit tests
// ---------------------------------------------------------------------------

describe("createLocalPayLedger — local specifics", () => {
  test("throws on negative initial budget", () => {
    expect(() => createLocalPayLedger({ initialBudget: "-100", agentId: "a" })).toThrow();
  });

  test("throws on non-numeric initial budget", () => {
    expect(() => createLocalPayLedger({ initialBudget: "abc", agentId: "a" })).toThrow();
  });

  test("close clears reservation timers", () => {
    const ledger = createLocalPayLedger({ initialBudget: "1000", agentId: "agent-1" });
    ledger.reserve("100", 60, "timer test");
    // Should not throw
    ledger.close();
  });

  test("SQLite persistence with :memory: works", async () => {
    const ledger = createLocalPayLedger({
      initialBudget: "500",
      agentId: "agent-1",
      dbPath: ":memory:",
    });

    await ledger.meter("50");
    const balance = await ledger.getBalance();
    expect(parseFloat(balance.available)).toBe(450);
    ledger.close();
  });

  test("multiple reservations tracked independently", async () => {
    const ledger = createLocalPayLedger({ initialBudget: "1000", agentId: "agent-1" });

    const r1 = await ledger.reserve("100", 60, "first");
    const r2 = await ledger.reserve("200", 60, "second");

    const balance = await ledger.getBalance();
    expect(parseFloat(balance.available)).toBe(700);
    expect(parseFloat(balance.reserved)).toBe(300);

    await ledger.release(r1.id);
    const afterRelease = await ledger.getBalance();
    expect(parseFloat(afterRelease.available)).toBe(800);
    expect(parseFloat(afterRelease.reserved)).toBe(200);

    await ledger.commit(r2.id, "150");
    const afterCommit = await ledger.getBalance();
    expect(parseFloat(afterCommit.available)).toBe(850);
    expect(parseFloat(afterCommit.reserved)).toBe(0);

    ledger.close();
  });

  test("commit unknown reservation throws", () => {
    const ledger = createLocalPayLedger({ initialBudget: "1000", agentId: "agent-1" });
    expect(() => ledger.commit("unknown-id")).toThrow(/unknown reservation/);
    ledger.close();
  });

  test("release unknown reservation throws", () => {
    const ledger = createLocalPayLedger({ initialBudget: "1000", agentId: "agent-1" });
    expect(() => ledger.release("unknown-id")).toThrow(/unknown reservation/);
    ledger.close();
  });

  test("transfer with insufficient balance throws", () => {
    const ledger = createLocalPayLedger({ initialBudget: "100", agentId: "agent-1" });
    expect(() => ledger.transfer("agent-2", "200")).toThrow(/insufficient/);
    ledger.close();
  });
});
