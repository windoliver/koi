import { describe, expect, test } from "bun:test";
import type { InboundMessage } from "@koi/core/message";
import { createCompositeArchiver } from "./composite-archiver.js";
import type { CompactionArchiver } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(text: string): InboundMessage {
  return {
    content: [{ kind: "text", text }],
    senderId: "user",
    timestamp: Date.now(),
  };
}

function createSpyArchiver(
  label: string,
  calls: string[],
  shouldThrow?: Error,
): CompactionArchiver {
  return {
    archive: async () => {
      calls.push(label);
      if (shouldThrow !== undefined) throw shouldThrow;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createCompositeArchiver", () => {
  test("calls all archivers with same messages and summary", async () => {
    const calls: string[] = [];
    const a = createSpyArchiver("a", calls);
    const b = createSpyArchiver("b", calls);
    const composite = createCompositeArchiver([a, b]);

    const messages = [makeMessage("hello")];
    await composite.archive(messages, "summary");

    expect(calls).toEqual(["a", "b"]);
  });

  test("empty array returns noop archiver (does not throw)", async () => {
    const composite = createCompositeArchiver([]);
    // Should not throw
    await composite.archive([makeMessage("x")], "sum");
  });

  test("single-element array returns original archiver (no wrapper)", () => {
    const calls: string[] = [];
    const single = createSpyArchiver("only", calls);
    const composite = createCompositeArchiver([single]);

    // Identity — same reference
    expect(composite).toBe(single);
  });

  test("second archiver runs even if first throws", async () => {
    const calls: string[] = [];
    const failing = createSpyArchiver("fail", calls, new Error("boom"));
    const passing = createSpyArchiver("pass", calls);
    const composite = createCompositeArchiver([failing, passing]);

    await expect(composite.archive([makeMessage("x")], "sum")).rejects.toBeInstanceOf(
      AggregateError,
    );

    // Both ran despite the first throwing
    expect(calls).toEqual(["fail", "pass"]);
  });

  test("throws AggregateError when any archiver fails", async () => {
    const calls: string[] = [];
    const err = new Error("boom");
    const failing = createSpyArchiver("fail", calls, err);
    const passing = createSpyArchiver("pass", calls);
    const composite = createCompositeArchiver([failing, passing]);

    try {
      await composite.archive([makeMessage("x")], "sum");
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(AggregateError);
      if (!(e instanceof AggregateError)) throw e;
      expect(e.errors).toHaveLength(1);
      expect(e.errors[0]).toBe(err);
    }
  });

  test("AggregateError contains all individual failures", async () => {
    const calls: string[] = [];
    const err1 = new Error("first");
    const err2 = new Error("second");
    const f1 = createSpyArchiver("f1", calls, err1);
    const f2 = createSpyArchiver("f2", calls, err2);
    const composite = createCompositeArchiver([f1, f2]);

    try {
      await composite.archive([makeMessage("x")], "sum");
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(AggregateError);
      if (!(e instanceof AggregateError)) throw e;
      expect(e.errors).toHaveLength(2);
      expect(e.errors[0]).toBe(err1);
      expect(e.errors[1]).toBe(err2);
    }
  });
});
