/**
 * Test data factories — reusable across all dashboard-ui component tests.
 *
 * Pattern: Use makeAgentSummary({ overrides }) to create test data with sensible defaults.
 * Every factory returns a frozen object to prevent accidental mutation in tests.
 */

import type {
  DashboardAgentDetail,
  DashboardAgentSummary,
  DashboardEvent,
  DashboardEventBatch,
} from "@koi/dashboard-types";

// ---------------------------------------------------------------------------
// Agent factories
// ---------------------------------------------------------------------------

let agentCounter = 0;

export function makeAgentSummary(
  overrides?: Partial<DashboardAgentSummary>,
): DashboardAgentSummary {
  agentCounter += 1;
  return Object.freeze({
    agentId: `agent-${agentCounter}`,
    name: `test-agent-${agentCounter}`,
    agentType: "copilot" as const,
    state: "running" as const,
    model: "claude-sonnet-4-6",
    channels: ["cli"],
    turns: 5,
    startedAt: Date.now() - 60_000,
    lastActivityAt: Date.now() - 1_000,
    ...overrides,
  }) as DashboardAgentSummary;
}

export function makeAgentDetail(overrides?: Partial<DashboardAgentDetail>): DashboardAgentDetail {
  const summary = makeAgentSummary(overrides);
  const detail: DashboardAgentDetail = {
    ...summary,
    skills: ["search", "code-review"],
    tokenCount: 1500,
    metadata: {},
    ...overrides,
  };
  return Object.freeze(detail);
}

// ---------------------------------------------------------------------------
// Event factories
// ---------------------------------------------------------------------------

export function makeStatusChangedEvent(agentId: string, from: string, to: string): DashboardEvent {
  return Object.freeze({
    kind: "agent" as const,
    subKind: "status_changed" as const,
    agentId,
    from,
    to,
    timestamp: Date.now(),
  }) as DashboardEvent;
}

export function makeEventBatch(events: readonly DashboardEvent[], seq = 1): DashboardEventBatch {
  return Object.freeze({
    events,
    seq,
    timestamp: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// Reset (call in beforeEach)
// ---------------------------------------------------------------------------

export function resetFixtureCounters(): void {
  agentCounter = 0;
}
