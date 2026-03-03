/**
 * Worker script smoke tests — verifies WORKER_SCRIPT is valid and handles
 * the basic ready → execute → result protocol.
 *
 * These tests catch drift between worker-source.ts (embedded string) and
 * worker-logic.ts (testable pure functions). The worker script is evaluated
 * in a controlled mock environment rather than spawning a real process.
 */

import { describe, expect, test } from "bun:test";
import { WORKER_SCRIPT } from "./worker-source.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockProcess {
  readonly sentMessages: unknown[];
  readonly exitCodes: number[];
  messageHandler: ((msg: unknown) => void) | null;
}

/**
 * Creates a mock `process` object that captures send() calls and exit() codes,
 * and exposes the registered message handler for manual triggering.
 */
function createMockProcess(): MockProcess {
  const mock: MockProcess = {
    sentMessages: [],
    exitCodes: [],
    messageHandler: null,
  };
  return mock;
}

/**
 * Evaluates the WORKER_SCRIPT in a sandboxed context with a mock process object.
 * Returns the mock for inspection.
 */
function evaluateWorkerScript(): MockProcess {
  const mock = createMockProcess();

  // Build a minimal `process` shim
  const processShim = {
    send: (msg: unknown) => {
      (mock.sentMessages as unknown[]).push(msg);
    },
    exit: (code: number) => {
      (mock.exitCodes as number[]).push(code);
    },
    on: (event: string, handler: (msg: unknown) => void) => {
      if (event === "message") {
        mock.messageHandler = handler;
      }
    },
  };

  // Evaluate the script with our process shim
  const fn = new Function("process", "performance", WORKER_SCRIPT);
  fn(processShim, performance);

  return mock;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WORKER_SCRIPT", () => {
  test("is a non-empty string", () => {
    expect(typeof WORKER_SCRIPT).toBe("string");
    expect(WORKER_SCRIPT.length).toBeGreaterThan(100);
  });

  test("is valid JavaScript (parseable without syntax errors)", () => {
    // If the script has syntax errors, this will throw
    expect(() => new Function("process", "performance", WORKER_SCRIPT)).not.toThrow();
  });

  test("sends ready message on startup", () => {
    const mock = evaluateWorkerScript();
    expect(mock.sentMessages).toContainEqual({ kind: "ready" });
  });

  test("registers a message handler", () => {
    const mock = evaluateWorkerScript();
    expect(mock.messageHandler).not.toBeNull();
  });

  test("rejects non-object messages", () => {
    const mock = evaluateWorkerScript();
    mock.messageHandler?.("not an object");

    // Should send an error about invalid message
    const errorMsg = mock.sentMessages.find(
      (m) => typeof m === "object" && m !== null && (m as { kind: string }).kind === "error",
    );
    expect(errorMsg).toBeDefined();
  });

  test("rejects unknown message kinds", () => {
    const mock = evaluateWorkerScript();
    mock.messageHandler?.({ kind: "unknown_kind" });

    const errorMsg = mock.sentMessages.find(
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as { kind: string }).kind === "error" &&
        (m as { message: string }).message.includes("Unknown message kind"),
    );
    expect(errorMsg).toBeDefined();
  });

  test("rejects invalid execute message fields", () => {
    const mock = evaluateWorkerScript();
    mock.messageHandler?.({ kind: "execute", code: 123, input: null, timeoutMs: "not a number" });

    const errorMsg = mock.sentMessages.find(
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as { kind: string }).kind === "error" &&
        (m as { message: string }).message.includes("Invalid execute message"),
    );
    expect(errorMsg).toBeDefined();
    expect(mock.exitCodes).toContain(1);
  });

  test("executes valid code and returns result", async () => {
    const mock = evaluateWorkerScript();

    // Send a valid execute message
    mock.messageHandler?.({
      kind: "execute",
      code: "return input.x + 1",
      input: { x: 41 },
      timeoutMs: 5000,
    });

    // Give async code time to resolve
    await new Promise((resolve) => setTimeout(resolve, 50));

    const resultMsg = mock.sentMessages.find(
      (m) => typeof m === "object" && m !== null && (m as { kind: string }).kind === "result",
    );
    expect(resultMsg).toBeDefined();
    expect((resultMsg as { output: number }).output).toBe(42);
    expect(typeof (resultMsg as { durationMs: number }).durationMs).toBe("number");
  });

  test("handles thrown errors in user code", async () => {
    const mock = evaluateWorkerScript();

    mock.messageHandler?.({
      kind: "execute",
      code: 'throw new Error("boom")',
      input: {},
      timeoutMs: 5000,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    const errorMsg = mock.sentMessages.find(
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as { kind: string }).kind === "error" &&
        (m as { code: string }).code === "CRASH",
    );
    expect(errorMsg).toBeDefined();
    expect((errorMsg as { message: string }).message).toContain("boom");
  });

  test("rejects duplicate execute messages", async () => {
    const mock = evaluateWorkerScript();

    // First execute — should succeed
    mock.messageHandler?.({
      kind: "execute",
      code: "return 1",
      input: {},
      timeoutMs: 5000,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    // Second execute — should be rejected
    mock.messageHandler?.({
      kind: "execute",
      code: "return 2",
      input: {},
      timeoutMs: 5000,
    });

    const duplicateError = mock.sentMessages.find(
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as { kind: string }).kind === "error" &&
        (m as { message: string }).message.includes("duplicate"),
    );
    expect(duplicateError).toBeDefined();
  });
});
