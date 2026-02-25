/**
 * Test artifact factories for forged bricks.
 *
 * Provides reusable defaults with a valid ForgeProvenance, eliminating
 * repeated fixture construction across test suites.
 */

import type {
  AgentArtifact,
  CompositeArtifact,
  ForgeProvenance,
  ImplementationArtifact,
  SkillArtifact,
  ToolArtifact,
} from "@koi/core";
import { createFactory } from "./factory.js";

// ---------------------------------------------------------------------------
// Default provenance — reusable across all factories
// ---------------------------------------------------------------------------

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
    finalTrustTier: "sandbox",
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

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

export const createTestToolArtifact: (overrides?: Partial<ToolArtifact>) => ToolArtifact =
  createFactory<ToolArtifact>({
    id: "brick_test-tool",
    kind: "tool",
    name: "test-tool",
    description: "A test tool",
    scope: "agent",
    trustTier: "sandbox",
    lifecycle: "active",
    provenance: DEFAULT_PROVENANCE,
    version: "0.0.1",
    tags: [],
    usageCount: 0,
    contentHash: "test-hash",
    implementation: "return 1;",
    inputSchema: { type: "object" },
  });

export const createTestSkillArtifact: (overrides?: Partial<SkillArtifact>) => SkillArtifact =
  createFactory<SkillArtifact>({
    id: "brick_test-skill",
    kind: "skill",
    name: "test-skill",
    description: "A test skill",
    scope: "agent",
    trustTier: "sandbox",
    lifecycle: "active",
    provenance: DEFAULT_PROVENANCE,
    version: "0.0.1",
    tags: [],
    usageCount: 0,
    contentHash: "test-hash",
    content: "# Test Skill",
  });

export const createTestAgentArtifact: (overrides?: Partial<AgentArtifact>) => AgentArtifact =
  createFactory<AgentArtifact>({
    id: "brick_test-agent",
    kind: "agent",
    name: "test-agent",
    description: "A test agent",
    scope: "agent",
    trustTier: "sandbox",
    lifecycle: "active",
    provenance: DEFAULT_PROVENANCE,
    version: "0.0.1",
    tags: [],
    usageCount: 0,
    contentHash: "test-hash",
    manifestYaml: "name: test-agent\ntype: assistant",
  });

export const createTestCompositeArtifact: (
  overrides?: Partial<CompositeArtifact>,
) => CompositeArtifact = createFactory<CompositeArtifact>({
  id: "brick_test-composite",
  kind: "composite",
  name: "test-composite",
  description: "A test composite",
  scope: "agent",
  trustTier: "sandbox",
  lifecycle: "active",
  provenance: DEFAULT_PROVENANCE,
  version: "0.0.1",
  tags: [],
  usageCount: 0,
  contentHash: "test-hash",
  brickIds: ["brick_a", "brick_b"],
});

export const createTestImplementationArtifact: (
  overrides?: Partial<ImplementationArtifact>,
) => ImplementationArtifact = createFactory<ImplementationArtifact>({
  id: "brick_test-impl",
  kind: "middleware",
  name: "test-impl",
  description: "A test implementation",
  scope: "agent",
  trustTier: "sandbox",
  lifecycle: "active",
  provenance: DEFAULT_PROVENANCE,
  version: "0.0.1",
  tags: [],
  usageCount: 0,
  contentHash: "test-hash",
  implementation: "return middleware;",
});
