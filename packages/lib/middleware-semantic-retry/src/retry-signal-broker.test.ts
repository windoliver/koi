/**
 * RetrySignalBroker tests — set/get/clear semantics and session isolation.
 */

import { describe, expect, it } from "bun:test";
import { createRetrySignalBroker } from "./retry-signal-broker.js";

describe("createRetrySignalBroker", () => {
  it("returns undefined when no signal is set", () => {
    const broker = createRetrySignalBroker();
    expect(broker.getRetrySignal("session-1")).toBeUndefined();
  });

  it("returns the signal after set", () => {
    const broker = createRetrySignalBroker();
    const signal = {
      retrying: true,
      originalStepIndex: 5,
      reason: "tool_misuse",
      failureClass: "tool_misuse",
      attemptNumber: 1,
    } as const;

    broker.setRetrySignal("session-1", signal);
    expect(broker.getRetrySignal("session-1")).toEqual(signal);
  });

  it("returns undefined after clear", () => {
    const broker = createRetrySignalBroker();
    broker.setRetrySignal("session-1", {
      retrying: true,
      originalStepIndex: 0,
      reason: "test",
      failureClass: "unknown",
      attemptNumber: 1,
    });

    broker.clearRetrySignal("session-1");
    expect(broker.getRetrySignal("session-1")).toBeUndefined();
  });

  it("isolates signals between sessions", () => {
    const broker = createRetrySignalBroker();
    const signal1 = {
      retrying: true,
      originalStepIndex: 1,
      reason: "reason-1",
      failureClass: "api_error",
      attemptNumber: 1,
    } as const;
    const signal2 = {
      retrying: true,
      originalStepIndex: 2,
      reason: "reason-2",
      failureClass: "tool_misuse",
      attemptNumber: 2,
    } as const;

    broker.setRetrySignal("session-1", signal1);
    broker.setRetrySignal("session-2", signal2);

    expect(broker.getRetrySignal("session-1")).toEqual(signal1);
    expect(broker.getRetrySignal("session-2")).toEqual(signal2);

    broker.clearRetrySignal("session-1");
    expect(broker.getRetrySignal("session-1")).toBeUndefined();
    expect(broker.getRetrySignal("session-2")).toEqual(signal2);
  });

  it("overwrites previous signal on re-set", () => {
    const broker = createRetrySignalBroker();
    broker.setRetrySignal("session-1", {
      retrying: true,
      originalStepIndex: 1,
      reason: "first",
      failureClass: "unknown",
      attemptNumber: 1,
    });

    const updated = {
      retrying: true,
      originalStepIndex: 1,
      reason: "second",
      failureClass: "api_error",
      attemptNumber: 2,
    } as const;
    broker.setRetrySignal("session-1", updated);
    expect(broker.getRetrySignal("session-1")).toEqual(updated);
  });
});
