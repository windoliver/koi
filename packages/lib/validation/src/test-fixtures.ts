/**
 * Shared test fixtures for @koi/validation tests.
 *
 * Inlined from @koi/test-utils-mocks for v2 scaffold independence.
 */

import type { ForgeProvenance, ToolArtifact } from "@koi/core";
import { brickId, DEFAULT_SANDBOXED_POLICY } from "@koi/core";

export const DEFAULT_PROVENANCE: ForgeProvenance = {
  source: { origin: "forged", forgedBy: "agent-1", sessionId: "session-1" },
  buildDefinition: {
    buildType: "koi.forge/tool/v1",
    externalParameters: {},
  },
  builder: {
    id: "koi.forge/pipeline/v1",
    version: "0.0.1",
  },
  metadata: {
    invocationId: "inv-test-001",
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_001_000,
    sessionId: "session-1",
    agentId: "agent-1",
    depth: 0,
  },
  verification: {
    passed: true,
    sandbox: true,
    totalDurationMs: 1000,
    stageResults: [
      { stage: "static", passed: true, durationMs: 100 },
      { stage: "sandbox", passed: true, durationMs: 400 },
      { stage: "self_test", passed: true, durationMs: 300 },
      { stage: "trust", passed: true, durationMs: 200 },
    ],
  },
  classification: "public",
  contentMarkers: [],
  contentHash: "test-hash",
};

export function createTestToolArtifact(overrides?: Partial<ToolArtifact>): ToolArtifact {
  return {
    id: brickId("brick_test-tool"),
    kind: "tool",
    name: "test-tool",
    description: "A test tool",
    scope: "agent",
    origin: "primordial",
    policy: DEFAULT_SANDBOXED_POLICY,
    lifecycle: "active",
    provenance: DEFAULT_PROVENANCE,
    version: "0.0.1",
    tags: [],
    usageCount: 0,
    implementation: "return 1;",
    inputSchema: { type: "object" },
    ...overrides,
  };
}
