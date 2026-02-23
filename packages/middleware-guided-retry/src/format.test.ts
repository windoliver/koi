import { describe, expect, test } from "bun:test";
import type { BacktrackConstraint } from "@koi/core";
import { formatConstraintMessage } from "./format.js";

describe("formatConstraintMessage", () => {
  const baseConstraint: BacktrackConstraint = {
    reason: {
      kind: "validation_failure",
      message: "Output schema mismatch",
      timestamp: 1700000000000,
    },
  };

  test("formats constraint with instructions", () => {
    const constraint: BacktrackConstraint = {
      ...baseConstraint,
      instructions: "Use strict JSON output format",
    };
    const msg = formatConstraintMessage(constraint);
    const text = msg.content[0];

    expect(text).toBeDefined();
    expect(text?.kind).toBe("text");
    if (text?.kind === "text") {
      expect(text?.text).toContain("Guidance: Use strict JSON output format");
    }
  });

  test("formats constraint without instructions", () => {
    const msg = formatConstraintMessage(baseConstraint);
    const text = msg.content[0];

    expect(text).toBeDefined();
    if (text?.kind === "text") {
      expect(text?.text).not.toContain("Guidance:");
    }
  });

  test("message senderId indicates system origin", () => {
    const msg = formatConstraintMessage(baseConstraint);
    expect(msg.senderId).toBe("system:guided-retry");
  });

  test("message includes reason kind and message", () => {
    const msg = formatConstraintMessage(baseConstraint);
    const text = msg.content[0];

    expect(text).toBeDefined();
    if (text?.kind === "text") {
      expect(text?.text).toContain("validation_failure");
      expect(text?.text).toContain("Output schema mismatch");
      expect(text?.text).toContain("[BACKTRACK GUIDANCE]");
    }
  });

  test("message timestamp matches reason timestamp", () => {
    const msg = formatConstraintMessage(baseConstraint);
    expect(msg.timestamp).toBe(1700000000000);
  });
});
