import { describe, expect, test } from "bun:test";
import type { PatternMatch, TaskItemId } from "@koi/core";
import { createPendingMatchStore } from "./store.js";

const TASK = "task_1" as unknown as TaskItemId;

function mk(
  opts: Partial<PatternMatch> & { event: string; stream: "stdout" | "stderr" },
): PatternMatch {
  return {
    taskId: opts.taskId ?? TASK,
    event: opts.event,
    stream: opts.stream,
    lineNumber: opts.lineNumber ?? 1,
    timestamp: opts.timestamp ?? 0,
  };
}

describe("createPendingMatchStore", () => {
  test("peek returns coalesced snapshot; ack clears those records", () => {
    const s = createPendingMatchStore();
    s.record(mk({ event: "e", stream: "stdout", lineNumber: 1 }));
    s.record(mk({ event: "e", stream: "stdout", lineNumber: 2 }));
    const reqA = {};
    const snap1 = s.peek(reqA);
    expect(snap1).toHaveLength(1);
    expect(snap1[0]?.count).toBe(2);
    s.ack(reqA);
    const snap2 = s.peek({});
    expect(snap2).toHaveLength(0);
  });

  test("peek is non-destructive; retry with same request returns same snapshot", () => {
    const s = createPendingMatchStore();
    s.record(mk({ event: "e", stream: "stdout" }));
    const req = {};
    const a = s.peek(req);
    const b = s.peek(req);
    expect(b).toEqual(a);
  });

  test("without ack, matches survive — simulates failed attempt + retry", () => {
    const s = createPendingMatchStore();
    s.record(mk({ event: "e", stream: "stdout", lineNumber: 1 }));
    const reqA = {};
    s.peek(reqA);
    s.record(mk({ event: "e", stream: "stdout", lineNumber: 2 }));
    // No ack(reqA) — attempt failed.
    const reqB = {};
    const snap = s.peek(reqB);
    expect(snap).toHaveLength(1);
    expect(snap[0]?.count).toBe(2);
  });

  test("ack only clears records in the peeked snapshot", () => {
    const s = createPendingMatchStore();
    s.record(mk({ event: "e", stream: "stdout", lineNumber: 1 }));
    const req = {};
    s.peek(req);
    s.record(mk({ event: "e", stream: "stdout", lineNumber: 2 })); // after peek
    s.ack(req);
    const after = s.peek({});
    expect(after).toHaveLength(1);
    expect(after[0]?.count).toBe(1);
    expect(after[0]?.firstMatch.lineNumber).toBe(2);
  });

  test("coalesce key includes stream: stdout and stderr are separate buckets", () => {
    const s = createPendingMatchStore();
    s.record(mk({ event: "e", stream: "stdout" }));
    s.record(mk({ event: "e", stream: "stderr" }));
    const snap = s.peek({});
    expect(snap).toHaveLength(2);
    expect(snap.map((c) => c.stream).sort()).toEqual(["stderr", "stdout"]);
  });

  test("ack on unseen request is a no-op", () => {
    const s = createPendingMatchStore();
    s.record(mk({ event: "e", stream: "stdout" }));
    s.ack({}); // never peeked
    expect(s.pending()).toBe(1);
  });

  test("dispose clears state and rejects further use", () => {
    const s = createPendingMatchStore();
    s.record(mk({ event: "e", stream: "stdout" }));
    s.dispose?.();
    expect(s.pending()).toBe(0);
    s.record(mk({ event: "e", stream: "stdout" })); // no-op
    expect(s.peek({})).toHaveLength(0);
  });

  test("registered matchers are cancelled on dispose", () => {
    const s = createPendingMatchStore();
    let cancelled = false;
    const matcher = {
      cancel: () => {
        cancelled = true;
      },
    };
    s.registerMatcher(matcher);
    s.dispose?.();
    expect(cancelled).toBe(true);
  });

  test("unregisterMatcher removes matcher before dispose", () => {
    const s = createPendingMatchStore();
    let cancelled = false;
    const matcher = {
      cancel: () => {
        cancelled = true;
      },
    };
    s.registerMatcher(matcher);
    s.unregisterMatcher(matcher);
    s.dispose?.();
    expect(cancelled).toBe(false);
  });

  test("pending() returns current bucket count", () => {
    const s = createPendingMatchStore();
    expect(s.pending()).toBe(0);
    s.record(mk({ event: "a", stream: "stdout" }));
    s.record(mk({ event: "a", stream: "stdout" }));
    expect(s.pending()).toBe(1); // 1 bucket, 2 matches
    s.record(mk({ event: "b", stream: "stdout" }));
    expect(s.pending()).toBe(2);
  });
});
