/**
 * Tests for ACP server types and constants.
 */

import { describe, expect, test } from "bun:test";
import { ACP_PROTOCOL_VERSION, DEFAULT_BACKPRESSURE_LIMIT, DEFAULT_TIMEOUTS } from "./types.js";

describe("DEFAULT_TIMEOUTS", () => {
  test("has expected default values", () => {
    expect(DEFAULT_TIMEOUTS.fsMs).toBe(30_000);
    expect(DEFAULT_TIMEOUTS.terminalMs).toBe(300_000);
    expect(DEFAULT_TIMEOUTS.permissionMs).toBe(60_000);
  });
});

describe("DEFAULT_BACKPRESSURE_LIMIT", () => {
  test("defaults to 100", () => {
    expect(DEFAULT_BACKPRESSURE_LIMIT).toBe(100);
  });
});

describe("ACP_PROTOCOL_VERSION", () => {
  test("is version 1", () => {
    expect(ACP_PROTOCOL_VERSION).toBe(1);
  });
});
