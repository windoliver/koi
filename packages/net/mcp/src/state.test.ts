import { describe, expect, mock, test } from "bun:test";
import type { KoiError } from "@koi/core";
import type { TransportState } from "./state.js";
import { createTransportStateMachine } from "./state.js";

const ERROR: KoiError = {
  code: "EXTERNAL",
  message: "test error",
  retryable: true,
};

// ---------------------------------------------------------------------------
// State machine creation
// ---------------------------------------------------------------------------

describe("createTransportStateMachine", () => {
  test("starts in idle state", () => {
    const sm = createTransportStateMachine();
    expect(sm.current.kind).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// Valid transitions
// ---------------------------------------------------------------------------

describe("valid transitions", () => {
  test("idle -> connecting", () => {
    const sm = createTransportStateMachine();
    sm.transition({ kind: "connecting", attempt: 1 });
    expect(sm.current.kind).toBe("connecting");
  });

  test("idle -> closed", () => {
    const sm = createTransportStateMachine();
    sm.transition({ kind: "closed" });
    expect(sm.current.kind).toBe("closed");
  });

  test("connecting -> connected", () => {
    const sm = createTransportStateMachine();
    sm.transition({ kind: "connecting", attempt: 1 });
    sm.transition({ kind: "connected", sessionId: "abc" });
    expect(sm.current.kind).toBe("connected");
    if (sm.current.kind === "connected") {
      expect(sm.current.sessionId).toBe("abc");
    }
  });

  test("connecting -> error", () => {
    const sm = createTransportStateMachine();
    sm.transition({ kind: "connecting", attempt: 1 });
    sm.transition({ kind: "error", error: ERROR, retryable: true });
    expect(sm.current.kind).toBe("error");
  });

  test("connecting -> auth-needed", () => {
    const sm = createTransportStateMachine();
    sm.transition({ kind: "connecting", attempt: 1 });
    sm.transition({ kind: "auth-needed", challenge: { type: "bearer" } });
    expect(sm.current.kind).toBe("auth-needed");
  });

  test("connecting -> closed", () => {
    const sm = createTransportStateMachine();
    sm.transition({ kind: "connecting", attempt: 1 });
    sm.transition({ kind: "closed" });
    expect(sm.current.kind).toBe("closed");
  });

  test("connected -> reconnecting", () => {
    const sm = createTransportStateMachine();
    sm.transition({ kind: "connecting", attempt: 1 });
    sm.transition({ kind: "connected" });
    sm.transition({ kind: "reconnecting", attempt: 1, lastError: ERROR });
    expect(sm.current.kind).toBe("reconnecting");
  });

  test("connected -> error", () => {
    const sm = createTransportStateMachine();
    sm.transition({ kind: "connecting", attempt: 1 });
    sm.transition({ kind: "connected" });
    sm.transition({ kind: "error", error: ERROR, retryable: false });
    expect(sm.current.kind).toBe("error");
  });

  test("connected -> closed", () => {
    const sm = createTransportStateMachine();
    sm.transition({ kind: "connecting", attempt: 1 });
    sm.transition({ kind: "connected" });
    sm.transition({ kind: "closed" });
    expect(sm.current.kind).toBe("closed");
  });

  test("reconnecting -> connected", () => {
    const sm = createTransportStateMachine();
    sm.transition({ kind: "connecting", attempt: 1 });
    sm.transition({ kind: "connected" });
    sm.transition({ kind: "reconnecting", attempt: 1, lastError: ERROR });
    sm.transition({ kind: "connected", sessionId: "new" });
    expect(sm.current.kind).toBe("connected");
  });

  test("reconnecting -> error", () => {
    const sm = createTransportStateMachine();
    sm.transition({ kind: "connecting", attempt: 1 });
    sm.transition({ kind: "connected" });
    sm.transition({ kind: "reconnecting", attempt: 1, lastError: ERROR });
    sm.transition({ kind: "error", error: ERROR, retryable: false });
    expect(sm.current.kind).toBe("error");
  });

  test("reconnecting -> auth-needed", () => {
    const sm = createTransportStateMachine();
    sm.transition({ kind: "connecting", attempt: 1 });
    sm.transition({ kind: "connected" });
    sm.transition({ kind: "reconnecting", attempt: 1, lastError: ERROR });
    sm.transition({ kind: "auth-needed" });
    expect(sm.current.kind).toBe("auth-needed");
  });

  test("reconnecting -> closed", () => {
    const sm = createTransportStateMachine();
    sm.transition({ kind: "connecting", attempt: 1 });
    sm.transition({ kind: "connected" });
    sm.transition({ kind: "reconnecting", attempt: 1, lastError: ERROR });
    sm.transition({ kind: "closed" });
    expect(sm.current.kind).toBe("closed");
  });

  test("auth-needed -> connecting", () => {
    const sm = createTransportStateMachine();
    sm.transition({ kind: "connecting", attempt: 1 });
    sm.transition({ kind: "auth-needed" });
    sm.transition({ kind: "connecting", attempt: 2 });
    expect(sm.current.kind).toBe("connecting");
  });

  test("auth-needed -> closed", () => {
    const sm = createTransportStateMachine();
    sm.transition({ kind: "connecting", attempt: 1 });
    sm.transition({ kind: "auth-needed" });
    sm.transition({ kind: "closed" });
    expect(sm.current.kind).toBe("closed");
  });

  test("error -> connecting (retry)", () => {
    const sm = createTransportStateMachine();
    sm.transition({ kind: "connecting", attempt: 1 });
    sm.transition({ kind: "error", error: ERROR, retryable: true });
    sm.transition({ kind: "connecting", attempt: 2 });
    expect(sm.current.kind).toBe("connecting");
  });

  test("error -> closed", () => {
    const sm = createTransportStateMachine();
    sm.transition({ kind: "connecting", attempt: 1 });
    sm.transition({ kind: "error", error: ERROR, retryable: false });
    sm.transition({ kind: "closed" });
    expect(sm.current.kind).toBe("closed");
  });
});

// ---------------------------------------------------------------------------
// Invalid transitions
// ---------------------------------------------------------------------------

describe("invalid transitions", () => {
  test("idle -> connected (must go through connecting)", () => {
    const sm = createTransportStateMachine();
    expect(() => sm.transition({ kind: "connected" })).toThrow(
      "Invalid transport state transition: idle -> connected",
    );
  });

  test("idle -> reconnecting", () => {
    const sm = createTransportStateMachine();
    expect(() => sm.transition({ kind: "reconnecting", attempt: 1, lastError: ERROR })).toThrow();
  });

  test("idle -> error", () => {
    const sm = createTransportStateMachine();
    expect(() => sm.transition({ kind: "error", error: ERROR, retryable: true })).toThrow();
  });

  test("idle -> auth-needed", () => {
    const sm = createTransportStateMachine();
    expect(() => sm.transition({ kind: "auth-needed" })).toThrow();
  });

  test("closed -> anything (terminal)", () => {
    const sm = createTransportStateMachine();
    sm.transition({ kind: "closed" });
    expect(() => sm.transition({ kind: "connecting", attempt: 1 })).toThrow();
    expect(() => sm.transition({ kind: "idle" } as TransportState)).toThrow();
  });

  test("connected -> connecting (must go through reconnecting/error)", () => {
    const sm = createTransportStateMachine();
    sm.transition({ kind: "connecting", attempt: 1 });
    sm.transition({ kind: "connected" });
    expect(() => sm.transition({ kind: "connecting", attempt: 2 })).toThrow();
  });

  test("connecting -> reconnecting", () => {
    const sm = createTransportStateMachine();
    sm.transition({ kind: "connecting", attempt: 1 });
    expect(() => sm.transition({ kind: "reconnecting", attempt: 1, lastError: ERROR })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// onChange listener
// ---------------------------------------------------------------------------

describe("onChange", () => {
  test("fires on state change", () => {
    const sm = createTransportStateMachine();
    const states: TransportState[] = [];
    sm.onChange((s) => states.push(s));

    sm.transition({ kind: "connecting", attempt: 1 });
    sm.transition({ kind: "connected" });

    expect(states).toHaveLength(2);
    expect(states[0]?.kind).toBe("connecting");
    expect(states[1]?.kind).toBe("connected");
  });

  test("unsubscribe stops notifications", () => {
    const sm = createTransportStateMachine();
    const listener = mock(() => {});
    const unsub = sm.onChange(listener);

    sm.transition({ kind: "connecting", attempt: 1 });
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();
    sm.transition({ kind: "connected" });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("does not fire on invalid transition attempt", () => {
    const sm = createTransportStateMachine();
    const listener = mock(() => {});
    sm.onChange(listener);

    try {
      sm.transition({ kind: "connected" });
    } catch {
      // expected
    }

    expect(listener).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// canTransitionTo
// ---------------------------------------------------------------------------

describe("canTransitionTo", () => {
  test("returns true for valid targets from idle", () => {
    const sm = createTransportStateMachine();
    expect(sm.canTransitionTo("connecting")).toBe(true);
    expect(sm.canTransitionTo("closed")).toBe(true);
  });

  test("returns false for invalid targets from idle", () => {
    const sm = createTransportStateMachine();
    expect(sm.canTransitionTo("connected")).toBe(false);
    expect(sm.canTransitionTo("reconnecting")).toBe(false);
    expect(sm.canTransitionTo("error")).toBe(false);
    expect(sm.canTransitionTo("auth-needed")).toBe(false);
  });

  test("returns false for any target from closed", () => {
    const sm = createTransportStateMachine();
    sm.transition({ kind: "closed" });
    expect(sm.canTransitionTo("connecting")).toBe(false);
    expect(sm.canTransitionTo("connected")).toBe(false);
    expect(sm.canTransitionTo("closed")).toBe(false);
  });
});
