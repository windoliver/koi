/**
 * Unit tests for generateEscalationMessage().
 */

import { describe, expect, test } from "bun:test";
import { agentId } from "@koi/core";
import { generateEscalationMessage } from "./escalation-message.js";
import type { EscalationContext } from "./types.js";

describe("generateEscalationMessage", () => {
  const baseCtx: EscalationContext = {
    issuerId: agentId("orchestrator"),
    exhaustedDelegateeIds: [agentId("w1"), agentId("w2")],
    detectedAt: 1700000000000,
  };

  test("generates message with delegatee list", () => {
    const msg = generateEscalationMessage(baseCtx);

    expect(msg.content).toHaveLength(1);
    const textBlock = msg.content[0];
    expect(textBlock?.kind).toBe("text");
    if (textBlock?.kind !== "text") return;

    expect(textBlock.text).toContain("orchestrator");
    expect(textBlock.text).toContain("w1");
    expect(textBlock.text).toContain("w2");
    expect(textBlock.text).toContain("abort");
  });

  test("includes task summary when provided", () => {
    const ctx: EscalationContext = {
      ...baseCtx,
      taskSummary: "Processing batch import of user records",
    };
    const msg = generateEscalationMessage(ctx);

    const textBlock = msg.content[0];
    if (textBlock?.kind !== "text") return;

    expect(textBlock.text).toContain("Processing batch import of user records");
    expect(textBlock.text).toContain("Task summary:");
  });

  test("omits task summary section when not provided", () => {
    const msg = generateEscalationMessage(baseCtx);

    const textBlock = msg.content[0];
    if (textBlock?.kind !== "text") return;

    expect(textBlock.text).not.toContain("Task summary:");
  });

  test("sets escalation metadata on the message", () => {
    const msg = generateEscalationMessage(baseCtx);

    expect(msg.metadata).toBeDefined();
    expect(msg.metadata?.escalation).toBe(true);
    expect(msg.metadata?.issuerId).toBe("orchestrator");
    expect(msg.metadata?.detectedAt).toBe(1700000000000);
    expect(msg.metadata?.delegateeCount).toBe(2);
  });
});
