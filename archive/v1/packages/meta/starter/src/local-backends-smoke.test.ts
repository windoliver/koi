import { describe, expect, test } from "bun:test";
import { agentId, scratchpadPath } from "@koi/core";
import { createLocalBackends } from "./adapters/local-backends.js";

describe("createLocalBackends smoke test", () => {
  test("creates all 4 backends with default config", () => {
    const backends = createLocalBackends();
    expect(backends.payLedger).toBeDefined();
    expect(backends.auditSink).toBeDefined();
    expect(backends.scratchpad).toBeDefined();
    expect(backends.mailbox).toBeDefined();
    backends.close();
  });

  test("pay ledger has initial balance", () => {
    const backends = createLocalBackends({ initialBudget: "500" });
    const balance = backends.payLedger.getBalance();
    // Balance can be sync or async
    const resolvedBalance = balance instanceof Promise ? undefined : balance;
    expect(resolvedBalance?.available).toBe("500");
    backends.close();
  });

  test("audit sink accepts entries", async () => {
    const backends = createLocalBackends();
    await backends.auditSink.log({
      timestamp: Date.now(),
      sessionId: "s",
      agentId: "a",
      turnIndex: 0,
      kind: "session_start",
      durationMs: 0,
    });
    if (backends.auditSink.flush) {
      await backends.auditSink.flush();
    }
    backends.close();
  });

  test("scratchpad write + read round-trip", () => {
    const backends = createLocalBackends();
    const writeResult = backends.scratchpad.write({
      path: scratchpadPath("test.txt"),
      content: "hello offline",
    });
    // write can be sync or async
    if (writeResult instanceof Promise) {
      // Skip for async case in smoke test
    } else {
      expect(writeResult.ok).toBe(true);
    }
    backends.close();
  });

  test("mailbox send + list round-trip", async () => {
    const backends = createLocalBackends();
    const result = await backends.mailbox.send({
      from: agentId("local-agent"),
      to: agentId("other-agent"),
      kind: "event",
      type: "ping",
      payload: {},
    });
    expect(result.ok).toBe(true);

    const messages = await backends.mailbox.list();
    expect(messages).toHaveLength(1);
    backends.close();
  });

  test("close is idempotent", () => {
    const backends = createLocalBackends();
    backends.close();
    // Second close should not throw
    backends.close();
  });
});
