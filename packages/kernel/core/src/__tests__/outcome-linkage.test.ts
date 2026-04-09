import { describe, expect, test } from "bun:test";
import type {
  DecisionCorrelationId,
  OutcomeReport,
  OutcomeReportInput,
  OutcomeStore,
  OutcomeValence,
} from "../outcome-linkage.js";
import { decisionCorrelationId } from "../outcome-linkage.js";

describe("outcome-linkage L0 types", () => {
  describe("decisionCorrelationId", () => {
    test("creates branded ID from plain string", () => {
      const id = decisionCorrelationId("dcid_abc-123");
      expect(String(id)).toBe("dcid_abc-123");
      // Branded type is structurally a string
      const plain: string = id;
      expect(typeof plain).toBe("string");
    });

    test("branded ID is assignable to DecisionCorrelationId", () => {
      const id: DecisionCorrelationId = decisionCorrelationId("test-id");
      expect(String(id)).toBe("test-id");
    });

    test("preserves empty string (validation is caller responsibility)", () => {
      const id = decisionCorrelationId("");
      expect(String(id)).toBe("");
    });
  });

  describe("OutcomeValence", () => {
    test("all valence values are valid string literals", () => {
      const valences: readonly OutcomeValence[] = [
        "positive",
        "negative",
        "neutral",
        "mixed",
      ] as const;
      expect(valences).toHaveLength(4);
    });
  });

  describe("OutcomeReport", () => {
    test("satisfies interface with all required fields", () => {
      const report: OutcomeReport = {
        correlationId: decisionCorrelationId("dcid_test"),
        outcome: "positive",
        metrics: { revenue: 50000, resolutionDays: 3 },
        description: "Deal closed successfully",
        reportedBy: "crm-webhook",
        timestamp: Date.now(),
      };
      expect(String(report.correlationId)).toBe("dcid_test");
      expect(report.outcome).toBe("positive");
      expect(report.metrics.revenue).toBe(50000);
    });

    test("accepts optional metadata", () => {
      const report: OutcomeReport = {
        correlationId: decisionCorrelationId("dcid_meta"),
        outcome: "negative",
        metrics: {},
        description: "Deal lost",
        reportedBy: "manual",
        timestamp: Date.now(),
        metadata: { dealId: "D-1234", reason: "competitor" },
      };
      expect(report.metadata).toBeDefined();
      expect(report.metadata?.dealId).toBe("D-1234");
    });

    test("metrics can be empty record", () => {
      const report: OutcomeReport = {
        correlationId: decisionCorrelationId("dcid_empty"),
        outcome: "neutral",
        metrics: {},
        description: "No measurable impact",
        reportedBy: "system",
        timestamp: 0,
      };
      expect(Object.keys(report.metrics)).toHaveLength(0);
    });
  });

  describe("OutcomeReportInput", () => {
    test("uses plain string correlationId (not branded)", () => {
      const input: OutcomeReportInput = {
        correlationId: "plain-string-id",
        outcome: "mixed",
        metrics: { nps: 7 },
        description: "Partial success",
        reportedBy: "survey-system",
      };
      expect(input.correlationId).toBe("plain-string-id");
    });
  });

  describe("OutcomeStore", () => {
    test("interface shape is correct (put + get only)", () => {
      // Compile-time check: OutcomeStore has exactly put and get
      const store: OutcomeStore = {
        put: async (_report: OutcomeReport): Promise<void> => {},
        get: async (_correlationId: string): Promise<OutcomeReport | undefined> => undefined,
      };
      expect(typeof store.put).toBe("function");
      expect(typeof store.get).toBe("function");
    });
  });
});
