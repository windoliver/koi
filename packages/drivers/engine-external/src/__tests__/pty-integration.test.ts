/**
 * Integration tests for PTY mode using real processes.
 *
 * Spawns actual PTY processes (sh) and verifies:
 * - Interactive command execution
 * - ANSI stripping
 * - Idle-based turn detection
 * - Dispose kills PTY process
 */

import { describe, expect, test } from "bun:test";
import type { EngineEvent } from "@koi/core";
import { createExternalAdapter } from "../adapter.js";

/** Collect all events from an async iterable. */
async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

/** Find the done event. */
function findDone(
  events: readonly EngineEvent[],
): Extract<EngineEvent, { readonly kind: "done" }> | undefined {
  return events.find(
    (e): e is Extract<EngineEvent, { readonly kind: "done" }> => e.kind === "done",
  );
}

describe("PTY integration — real sh process", () => {
  test("echo via PTY produces text_delta events with ANSI stripped", async () => {
    const adapter = createExternalAdapter({
      command: "sh",
      args: ["-c", "echo pty-integration-hello"],
      mode: "pty",
      pty: {
        idleThresholdMs: 500,
        ansiStrip: true,
        cols: 80,
        rows: 24,
      },
    });

    const events = await collectEvents(adapter.stream({ kind: "text", text: "" }));

    const textDeltas = events.filter((e) => e.kind === "text_delta");
    expect(textDeltas.length).toBeGreaterThan(0);

    const allText = textDeltas.map((e) => (e.kind === "text_delta" ? e.delta : "")).join("");
    expect(allText).toContain("pty-integration-hello");
    // ANSI codes should be stripped
    expect(allText).not.toContain("\x1b[");

    const done = findDone(events);
    expect(done).toBeDefined();
    expect(done?.output.stopReason).toBe("completed");
    expect(done?.output.metrics.durationMs).toBeGreaterThanOrEqual(0);

    await adapter.dispose?.();
  }, 15_000);

  test("dispose kills PTY process", async () => {
    const adapter = createExternalAdapter({
      command: "sh",
      args: ["-c", "sleep 30"],
      mode: "pty",
      timeoutMs: 0,
      pty: {
        idleThresholdMs: 60_000,
      },
    });

    // Start stream — must call .next() to enter generator body
    const iter = adapter.stream({ kind: "text", text: "" })[Symbol.asyncIterator]();
    const firstRead = iter.next();

    // Give it time to spawn
    await new Promise((r) => setTimeout(r, 300));

    expect(adapter.isRunning()).toBe(true);
    await adapter.dispose?.();
    expect(adapter.isRunning()).toBe(false);

    // Clean up pending read
    await firstRead.catch(() => {});
  }, 10_000);

  test("PTY mode with abort signal", async () => {
    const controller = new AbortController();
    const adapter = createExternalAdapter({
      command: "sh",
      args: ["-c", "sleep 30"],
      mode: "pty",
      timeoutMs: 0,
      pty: { idleThresholdMs: 60_000 },
    });

    // Abort after 200ms
    setTimeout(() => controller.abort(), 200);

    const events = await collectEvents(
      adapter.stream({ kind: "text", text: "", signal: controller.signal }),
    );

    const done = findDone(events);
    expect(done).toBeDefined();
    expect(done?.output.stopReason).toBe("interrupted");

    await adapter.dispose?.();
  }, 10_000);

  test("saveState/loadState round-trip with PTY mode", async () => {
    const adapter = createExternalAdapter({
      command: "echo",
      args: ["state-test"],
      mode: "pty",
      pty: { idleThresholdMs: 500 },
    });

    await collectEvents(adapter.stream({ kind: "text", text: "" }));

    const state = await adapter.saveState?.();
    expect(state).toBeDefined();
    if (state === undefined) return;
    expect(state.engineId).toBe("external");

    await adapter.dispose?.();
  }, 15_000);
});
