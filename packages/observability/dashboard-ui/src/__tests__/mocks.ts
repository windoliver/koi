/**
 * Mock factories for dashboard-ui tests.
 */

import type { DashboardAgentSummary } from "@koi/dashboard-types";

// ---------------------------------------------------------------------------
// Mock fetch — intercepts global fetch for API client tests
// ---------------------------------------------------------------------------

export function mockFetchResponse<T>(data: T): void {
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ ok: true, data }), {
        headers: { "content-type": "application/json" },
      }),
    )) as typeof fetch;
}

export function mockFetchAgents(agents: readonly DashboardAgentSummary[]): void {
  mockFetchResponse(agents);
}
