/**
 * Tests for formatContextEngineSwapNotice — TUI-facing notice adapter
 * (issue #1767, Phase 6; consumes #1940 single-writer policy).
 */

import { describe, expect, test } from "bun:test";
import type { ContextEngineSwapEvent } from "@koi/core";
import { formatContextEngineSwapNotice } from "./format-swap-notice.js";

const baseEvent: ContextEngineSwapEvent = {
  kind: "context-engine-swap",
  turnId: "run-1:t3" as ContextEngineSwapEvent["turnId"],
  from: { name: "@koi/context-manager", version: "1.0.0" },
  to: { name: "@koi/context-manager/passthrough", version: "1.0.0" },
  reason: "operator forced full-context for debugging",
  timestamp: "2026-05-02T12:00:00.000Z",
};

describe("formatContextEngineSwapNotice", () => {
  test("returns a stable id derived from turnId so duplicates are rejected", () => {
    const a = formatContextEngineSwapNotice(baseEvent);
    const b = formatContextEngineSwapNotice(baseEvent);
    expect(a.id).toBe(b.id);
    expect(a.id.startsWith("info-context-engine-swap-")).toBe(true);
  });

  test("message names both engines and the reason", () => {
    const notice = formatContextEngineSwapNotice(baseEvent);
    expect(notice.message).toContain("@koi/context-manager");
    expect(notice.message).toContain("@koi/context-manager/passthrough");
    expect(notice.message).toContain("operator forced full-context for debugging");
  });

  test("rollback events render with a distinct prefix", () => {
    const rollback: ContextEngineSwapEvent = {
      ...baseEvent,
      from: baseEvent.to,
      to: baseEvent.from,
      reason: "regression detected by evaluator",
    };
    const notice = formatContextEngineSwapNotice(rollback);
    expect(notice.message).toContain("regression detected by evaluator");
  });

  test("payload conforms to the TUI info-message shape (id + message strings only)", () => {
    const notice = formatContextEngineSwapNotice(baseEvent);
    expect(typeof notice.id).toBe("string");
    expect(typeof notice.message).toBe("string");
    expect(Object.keys(notice).sort()).toEqual(["id", "message"]);
  });

  test("two swaps in one run produce distinct ids per turn", () => {
    const evt2: ContextEngineSwapEvent = {
      ...baseEvent,
      turnId: "run-1:t9" as ContextEngineSwapEvent["turnId"],
    };
    const a = formatContextEngineSwapNotice(baseEvent);
    const b = formatContextEngineSwapNotice(evt2);
    expect(a.id).not.toBe(b.id);
  });
});
