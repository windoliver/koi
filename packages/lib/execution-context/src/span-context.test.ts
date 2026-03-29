import { describe, expect, test } from "bun:test";
import type { ChildSpanRecord } from "./span-context.js";
import { getSpanRecorder, runWithSpanRecorder } from "./span-context.js";

describe("getSpanRecorder", () => {
  test("returns undefined outside a span recorder scope", () => {
    expect(getSpanRecorder()).toBeUndefined();
  });
});

describe("runWithSpanRecorder", () => {
  test("makes recorder available inside the callback", () => {
    const spans: ChildSpanRecord[] = [];
    const recorder = {
      record: (span: ChildSpanRecord): void => {
        spans.push(span);
      },
    };

    runWithSpanRecorder(recorder, () => {
      const r = getSpanRecorder();
      expect(r).toBeDefined();
      r?.record({ label: "test-span", durationMs: 42 });
    });

    expect(spans).toHaveLength(1);
    expect(spans[0]?.label).toBe("test-span");
    expect(spans[0]?.durationMs).toBe(42);
  });

  test("recorder is undefined after scope exits", () => {
    const recorder = { record: (): void => {} };
    runWithSpanRecorder(recorder, () => {});
    expect(getSpanRecorder()).toBeUndefined();
  });

  test("returns the callback return value", () => {
    const recorder = { record: (): void => {} };
    const result = runWithSpanRecorder(recorder, () => "hello");
    expect(result).toBe("hello");
  });

  test("isolates concurrent async contexts", async () => {
    const spansA: ChildSpanRecord[] = [];
    const spansB: ChildSpanRecord[] = [];
    const recorderA = {
      record: (span: ChildSpanRecord): void => {
        spansA.push(span);
      },
    };
    const recorderB = {
      record: (span: ChildSpanRecord): void => {
        spansB.push(span);
      },
    };

    await Promise.all([
      runWithSpanRecorder(recorderA, async () => {
        await new Promise((r) => setTimeout(r, 10));
        getSpanRecorder()?.record({ label: "A", durationMs: 1 });
      }),
      runWithSpanRecorder(recorderB, async () => {
        await new Promise((r) => setTimeout(r, 5));
        getSpanRecorder()?.record({ label: "B", durationMs: 2 });
      }),
    ]);

    expect(spansA).toHaveLength(1);
    expect(spansA[0]?.label).toBe("A");
    expect(spansB).toHaveLength(1);
    expect(spansB[0]?.label).toBe("B");
  });

  test("supports nested scopes", () => {
    const outerSpans: ChildSpanRecord[] = [];
    const innerSpans: ChildSpanRecord[] = [];
    const outerRecorder = {
      record: (span: ChildSpanRecord): void => {
        outerSpans.push(span);
      },
    };
    const innerRecorder = {
      record: (span: ChildSpanRecord): void => {
        innerSpans.push(span);
      },
    };

    runWithSpanRecorder(outerRecorder, () => {
      getSpanRecorder()?.record({ label: "outer", durationMs: 1 });

      runWithSpanRecorder(innerRecorder, () => {
        getSpanRecorder()?.record({ label: "inner", durationMs: 2 });
      });

      // After inner scope, outer recorder is restored
      getSpanRecorder()?.record({ label: "outer-after", durationMs: 3 });
    });

    expect(outerSpans).toHaveLength(2);
    expect(outerSpans[0]?.label).toBe("outer");
    expect(outerSpans[1]?.label).toBe("outer-after");
    expect(innerSpans).toHaveLength(1);
    expect(innerSpans[0]?.label).toBe("inner");
  });
});
