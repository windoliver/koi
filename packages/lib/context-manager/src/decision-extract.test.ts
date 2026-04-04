/**
 * Decision signal extraction tests.
 *
 * Tests pattern matching, metadata key extraction, and configuration.
 */

import { describe, expect, it } from "bun:test";
import type { InboundMessage } from "@koi/core";
import { extractDecisionSignals } from "./decision-extract.js";

/** Helper to create a text message with optional metadata. */
function msg(text: string, metadata?: Record<string, unknown>): InboundMessage {
  return {
    content: [{ kind: "text", text }],
    senderId: "user",
    timestamp: 1000,
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

describe("extractDecisionSignals", () => {
  describe("pattern matching", () => {
    it("detects approval language", () => {
      const signals = extractDecisionSignals([msg("The budget was approved by the team lead.")]);
      expect(signals.length).toBeGreaterThanOrEqual(1);
      expect(signals.some((s) => s.kind === "approval")).toBe(true);
    });

    it("detects pricing language", () => {
      const signals = extractDecisionSignals([msg("The price is $50 per unit.")]);
      expect(signals.length).toBeGreaterThanOrEqual(1);
      expect(signals.some((s) => s.kind === "pricing")).toBe(true);
    });

    it("detects constraint language", () => {
      const signals = extractDecisionSignals([msg("The service must not exceed 100ms latency.")]);
      expect(signals.length).toBeGreaterThanOrEqual(1);
      expect(signals.some((s) => s.kind === "constraint")).toBe(true);
    });

    it("detects preference language", () => {
      const signals = extractDecisionSignals([msg("We prefer the Redis-based approach instead.")]);
      expect(signals.length).toBeGreaterThanOrEqual(1);
      expect(signals.some((s) => s.kind === "preference")).toBe(true);
    });

    it("detects rationale language", () => {
      const signals = extractDecisionSignals([msg("We chose this because it reduces latency.")]);
      expect(signals.length).toBeGreaterThanOrEqual(1);
      expect(signals.some((s) => s.kind === "rationale")).toBe(true);
    });

    it("returns empty for messages without decision language", () => {
      const signals = extractDecisionSignals([msg("Hello, how are you today?")]);
      expect(signals.length).toBe(0);
    });

    it("deduplicates same kind per message", () => {
      // "approved" and "confirmed" are both approval patterns
      const signals = extractDecisionSignals([
        msg("The change was approved and confirmed by the team."),
      ]);
      const approvalSignals = signals.filter((s) => s.kind === "approval");
      expect(approvalSignals.length).toBe(1);
    });

    it("extracts multiple kinds from one message", () => {
      const signals = extractDecisionSignals([
        msg("The price was approved because it meets our budget requirement."),
      ]);
      // Should have at least approval + pricing + rationale + constraint
      const kinds = new Set(signals.map((s) => s.kind));
      expect(kinds.size).toBeGreaterThanOrEqual(2);
    });
  });

  describe("metadata key extraction", () => {
    it("detects decision metadata key", () => {
      const signals = extractDecisionSignals([msg("something", { decision: "go ahead" })]);
      expect(signals.length).toBeGreaterThanOrEqual(1);
      expect(signals.some((s) => s.kind === "custom")).toBe(true);
    });

    it("uses string metadata value as summary", () => {
      const signals = extractDecisionSignals([msg("something", { approval: "CFO sign-off" })]);
      const custom = signals.find((s) => s.kind === "custom");
      expect(custom).toBeDefined();
      expect(custom?.summary).toBe("CFO sign-off");
    });

    it("handles non-string metadata values", () => {
      const signals = extractDecisionSignals([msg("something", { decision: true })]);
      const custom = signals.find((s) => s.kind === "custom");
      expect(custom).toBeDefined();
      expect(custom?.summary).toContain("metadata.decision present");
    });
  });

  describe("configuration", () => {
    it("respects custom patterns", () => {
      const signals = extractDecisionSignals([msg("LGTM, ship it")], 0, {
        patterns: [{ kind: "approval", pattern: /\bLGTM\b/i }],
      });
      expect(signals.some((s) => s.kind === "approval")).toBe(true);
    });

    it("respects custom metadata keys", () => {
      const signals = extractDecisionSignals([msg("text", { myCustomKey: "value" })], 0, {
        metadataKeys: ["myCustomKey"],
      });
      expect(signals.some((s) => s.kind === "custom")).toBe(true);
    });

    it("skips defaults when skipDefaults is true", () => {
      // "approved" would normally match default patterns
      const signals = extractDecisionSignals([msg("The budget was approved.")], 0, {
        skipDefaults: true,
      });
      expect(signals.length).toBe(0);
    });

    it("uses only custom patterns when skipDefaults is true", () => {
      const signals = extractDecisionSignals([msg("LGTM, ship it")], 0, {
        skipDefaults: true,
        patterns: [{ kind: "approval", pattern: /\bLGTM\b/i }],
      });
      expect(signals.length).toBe(1);
      expect(signals[0]?.kind).toBe("approval");
    });
  });

  describe("message index offset", () => {
    it("applies offset to sourceMessageIndex", () => {
      const signals = extractDecisionSignals([msg("The price is $100.")], 5);
      expect(signals.length).toBeGreaterThan(0);
      expect(signals[0]?.sourceMessageIndex).toBe(5);
    });

    it("increments offset per message", () => {
      const signals = extractDecisionSignals(
        [msg("The price is $100."), msg("This was approved.")],
        10,
      );
      const pricing = signals.find((s) => s.kind === "pricing");
      const approval = signals.find((s) => s.kind === "approval");
      expect(pricing?.sourceMessageIndex).toBe(10);
      expect(approval?.sourceMessageIndex).toBe(11);
    });
  });

  describe("edge cases", () => {
    it("handles empty message array", () => {
      const signals = extractDecisionSignals([]);
      expect(signals.length).toBe(0);
    });

    it("handles messages with no text blocks", () => {
      const imageMsg: InboundMessage = {
        content: [{ kind: "image", url: "https://example.com/img.png" }],
        senderId: "user",
        timestamp: 1000,
      };
      const signals = extractDecisionSignals([imageMsg]);
      expect(signals.length).toBe(0);
    });

    it("uses message timestamp for signal timestamp", () => {
      const signals = extractDecisionSignals([msg("This was approved.")]);
      expect(signals[0]?.timestamp).toBe(1000);
    });

    it("handles stateful /g regexes across multiple messages", () => {
      const signals = extractDecisionSignals(
        [msg("The price is $50."), msg("Another price is $100.")],
        0,
        {
          skipDefaults: true,
          patterns: [{ kind: "pricing", pattern: /price/gi }],
        },
      );
      // Both messages should match despite global flag
      expect(signals.length).toBe(2);
    });

    it("handles sticky /y regexes", () => {
      const signals = extractDecisionSignals([msg("approved by the board")], 0, {
        skipDefaults: true,
        patterns: [{ kind: "approval", pattern: /approved/y }],
      });
      expect(signals.length).toBe(1);
    });
  });
});
