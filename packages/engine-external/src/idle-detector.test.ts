import { afterEach, describe, expect, test } from "bun:test";
import type { IdleDetector } from "./idle-detector.js";
import { createIdleDetector } from "./idle-detector.js";

describe("createIdleDetector", () => {
  // let: detector under test — cleaned up after each test
  let detector: IdleDetector | undefined;

  afterEach(() => {
    detector?.dispose();
    detector = undefined;
  });

  test("fires onIdle after silence exceeds threshold", async () => {
    // let: flag set by callback
    let idleFired = false;

    detector = createIdleDetector({
      idleThresholdMs: 100,
      pollIntervalMs: 50,
      onIdle() {
        idleFired = true;
      },
    });

    // Record some output initially
    detector.recordOutput("hello");

    // Wait less than threshold — should not fire
    await new Promise((r) => setTimeout(r, 60));
    expect(idleFired).toBe(false);

    // Wait past threshold
    await new Promise((r) => setTimeout(r, 120));
    expect(idleFired).toBe(true);
  });

  test("resets timer on new output", async () => {
    // let: flag set by callback
    let idleFired = false;

    detector = createIdleDetector({
      idleThresholdMs: 150,
      pollIntervalMs: 50,
      onIdle() {
        idleFired = true;
      },
    });

    detector.recordOutput("chunk1");
    await new Promise((r) => setTimeout(r, 80));
    expect(idleFired).toBe(false);

    // Reset with new output
    detector.recordOutput("chunk2");
    await new Promise((r) => setTimeout(r, 80));
    expect(idleFired).toBe(false);

    // Now wait past threshold from last output
    await new Promise((r) => setTimeout(r, 120));
    expect(idleFired).toBe(true);
  });

  test("fires immediately on prompt pattern match", () => {
    // let: flag set by callback
    let idleFired = false;

    detector = createIdleDetector({
      idleThresholdMs: 30_000, // Very long — should never fire from timeout
      pollIntervalMs: 1_000,
      promptPattern: /\$ $/,
      onIdle() {
        idleFired = true;
      },
    });

    detector.recordOutput("user@host:~");
    expect(idleFired).toBe(false);

    detector.recordOutput("$ ");
    expect(idleFired).toBe(true);
  });

  test("fires only once even with continued output", async () => {
    // let: counter to track how many times callback fires
    let fireCount = 0;

    detector = createIdleDetector({
      idleThresholdMs: 50,
      pollIntervalMs: 30,
      onIdle() {
        fireCount++;
      },
    });

    // Wait for idle to fire
    await new Promise((r) => setTimeout(r, 150));
    expect(fireCount).toBe(1);

    // More output after idle fired — should not fire again
    detector.recordOutput("late output");
    await new Promise((r) => setTimeout(r, 150));
    expect(fireCount).toBe(1);
  });

  test("dispose prevents firing", async () => {
    // let: flag set by callback
    let idleFired = false;

    detector = createIdleDetector({
      idleThresholdMs: 50,
      pollIntervalMs: 30,
      onIdle() {
        idleFired = true;
      },
    });

    detector.dispose();

    await new Promise((r) => setTimeout(r, 150));
    expect(idleFired).toBe(false);
  });

  test("prompt pattern matches across multiple chunks", () => {
    // let: flag set by callback
    let idleFired = false;

    detector = createIdleDetector({
      idleThresholdMs: 30_000,
      promptPattern: />>> $/,
      onIdle() {
        idleFired = true;
      },
    });

    detector.recordOutput("Python 3.12.0\n");
    expect(idleFired).toBe(false);

    detector.recordOutput(">>> ");
    expect(idleFired).toBe(true);
  });
});
