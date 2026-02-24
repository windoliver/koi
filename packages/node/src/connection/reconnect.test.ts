import { describe, expect, it } from "bun:test";
import type { GatewayConnectionConfig } from "../types.js";
import {
  computeReconnectDelay,
  createReconnectState,
  isCleanClose,
  nextAttempt,
  resetReconnectState,
} from "./reconnect.js";

const config: GatewayConnectionConfig = {
  url: "wss://gw.example.com",
  reconnectBaseDelay: 1_000,
  reconnectMaxDelay: 30_000,
  reconnectMultiplier: 2,
  reconnectJitter: 0.1,
  maxRetries: 5,
};

describe("computeReconnectDelay", () => {
  it("returns base delay for attempt 0 (approximately)", () => {
    const delay = computeReconnectDelay(0, { ...config, reconnectJitter: 0 });
    expect(delay).toBe(1_000);
  });

  it("doubles delay per attempt (no jitter)", () => {
    const noJitter = { ...config, reconnectJitter: 0 };
    expect(computeReconnectDelay(0, noJitter)).toBe(1_000);
    expect(computeReconnectDelay(1, noJitter)).toBe(2_000);
    expect(computeReconnectDelay(2, noJitter)).toBe(4_000);
    expect(computeReconnectDelay(3, noJitter)).toBe(8_000);
  });

  it("caps at maxDelay", () => {
    const noJitter = { ...config, reconnectJitter: 0 };
    expect(computeReconnectDelay(10, noJitter)).toBe(30_000);
    expect(computeReconnectDelay(20, noJitter)).toBe(30_000);
  });

  it("applies jitter within expected range", () => {
    const delays = Array.from({ length: 100 }, () => computeReconnectDelay(0, config));
    const min = Math.min(...delays);
    const max = Math.max(...delays);
    // With 10% jitter on 1000ms: range is [900, 1100]
    expect(min).toBeGreaterThanOrEqual(900);
    expect(max).toBeLessThanOrEqual(1100);
  });

  it("never returns negative", () => {
    const delays = Array.from({ length: 100 }, () => computeReconnectDelay(0, config));
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("reconnect state machine", () => {
  it("starts at attempt 0 and not exhausted", () => {
    const state = createReconnectState();
    expect(state.attempt).toBe(0);
    expect(state.exhausted).toBe(false);
  });

  it("advances attempt count", () => {
    let state = createReconnectState();
    state = nextAttempt(state, 5);
    expect(state.attempt).toBe(1);
    expect(state.exhausted).toBe(false);
  });

  it("becomes exhausted when reaching maxRetries", () => {
    let state = createReconnectState();
    for (let i = 0; i < 4; i++) {
      state = nextAttempt(state, 5);
      expect(state.exhausted).toBe(false);
    }
    state = nextAttempt(state, 5);
    expect(state.exhausted).toBe(true);
    expect(state.attempt).toBe(5);
  });

  it("never exhausts with maxRetries = 0 (unlimited)", () => {
    let state = createReconnectState();
    for (let i = 0; i < 100; i++) {
      state = nextAttempt(state, 0);
      expect(state.exhausted).toBe(false);
    }
  });

  it("resets to initial state", () => {
    const state = resetReconnectState();
    expect(state.attempt).toBe(0);
    expect(state.exhausted).toBe(false);
  });
});

describe("isCleanClose", () => {
  it("returns true for code 1000 (normal closure)", () => {
    expect(isCleanClose(1000)).toBe(true);
  });

  it("returns true for code 1001 (going away)", () => {
    expect(isCleanClose(1001)).toBe(true);
  });

  it("returns false for code 1006 (abnormal closure)", () => {
    expect(isCleanClose(1006)).toBe(false);
  });

  it("returns false for code 4000 (custom)", () => {
    expect(isCleanClose(4000)).toBe(false);
  });
});
