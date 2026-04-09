/**
 * In-memory OutcomeStore for tests and local development (no Nexus required).
 *
 * Simple Map-backed implementation. Data is lost on process exit.
 */

import type { OutcomeReport, OutcomeStore } from "@koi/core";

/** Create an in-memory outcome store. */
export function createInMemoryOutcomeStore(): OutcomeStore {
  const reports = new Map<string, OutcomeReport>();

  return {
    async put(report: OutcomeReport): Promise<void> {
      reports.set(report.correlationId, report);
    },

    async get(correlationId: string): Promise<OutcomeReport | undefined> {
      return reports.get(correlationId);
    },
  };
}
