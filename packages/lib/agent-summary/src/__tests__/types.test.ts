import { describe, test } from "bun:test";
import type { SummaryOk, SummaryRangeOptions, SummarySessionOptions } from "../types.js";

describe("SummaryOk discriminated union", () => {
  test("un-narrowed access to body fields is a TS error", () => {
    const ok = {} as SummaryOk;
    // @ts-expect-error — `.summary` lives only on the clean variant
    ok.summary;
    // @ts-expect-error — `.partial` lives only on the degraded variant
    ok.partial;
    // @ts-expect-error — `.derived` lives only on the compacted variant
    ok.derived;
  });

  test("narrowing on kind grants access to the right body", () => {
    const ok = {} as SummaryOk;
    if (ok.kind === "clean") {
      ok.summary;
    } else if (ok.kind === "degraded") {
      ok.partial;
      ok.skipped;
      ok.droppedTailTurns;
    } else {
      ok.derived;
      ok.compactionEntryCount;
      ok.skipped;
      ok.droppedTailTurns;
    }
  });
});

describe("options split — range vs session", () => {
  test("crashTailStrategy is only on session options", () => {
    const range = {} as SummaryRangeOptions;
    // @ts-expect-error — crashTailStrategy is not on the range option shape
    range.crashTailStrategy;
    const session = {} as SummarySessionOptions;
    session.crashTailStrategy;
    session.allowCompacted;
  });
});
