import type {
  BrickArtifact,
  BrickId,
  ForgeProvenance,
  ForgeVerificationSummary,
  ToolArtifact,
} from "@koi/core";
import { brickId, DEFAULT_SANDBOXED_POLICY } from "@koi/core";
import { computeBrickId } from "@koi/hash";

const passingVerification: ForgeVerificationSummary = {
  passed: true,
  sandbox: true,
  totalDurationMs: 1,
  stageResults: [],
};

const baseProvenance: ForgeProvenance = {
  source: { origin: "forged", forgedBy: "agent-1", sessionId: "sess-1" },
  buildDefinition: { buildType: "koi.forge.tool/v1", externalParameters: {} },
  builder: { id: "koi/forge" },
  metadata: {
    invocationId: "inv-1",
    startedAt: 1,
    finishedAt: 2,
    sessionId: "sess-1",
    agentId: "agent-1",
    depth: 0,
  },
  verification: passingVerification,
  classification: "public",
  contentMarkers: [],
  contentHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
};

interface MakeToolOptions {
  readonly implementation?: string;
  readonly name?: string;
  readonly parentBrickId?: BrickId | undefined;
  readonly id?: BrickId | undefined;
  readonly builderId?: string | undefined;
}

/**
 * Test fixture using a simplified identity scheme — kind+implementation —
 * for unit-test isolation. Production bricks use the canonical scheme in
 * `@koi/forge-tools`. The recompute function passed to `verifyBrickIntegrity`
 * must match whatever the producer used; here that's `recomputeFixtureId`.
 */
export function recomputeFixtureId(brick: BrickArtifact): BrickId {
  if (brick.kind !== "tool") throw new Error("fixture: tool only");
  return computeBrickId("tool", brick.implementation);
}

export function makeTool(options: MakeToolOptions = {}): ToolArtifact {
  const implementation = options.implementation ?? "export default () => 1";
  const id = options.id ?? computeBrickId("tool", implementation);
  const builder =
    options.builderId !== undefined ? { id: options.builderId } : baseProvenance.builder;
  const withBuilder: ForgeProvenance = { ...baseProvenance, builder };
  const provenance: ForgeProvenance =
    options.parentBrickId !== undefined
      ? { ...withBuilder, parentBrickId: options.parentBrickId, evolutionKind: "fix" }
      : withBuilder;
  return {
    id,
    kind: "tool",
    name: options.name ?? "sample-tool",
    description: "fixture",
    scope: "agent",
    origin: "forged",
    policy: DEFAULT_SANDBOXED_POLICY,
    lifecycle: "active",
    provenance,
    version: "1.0.0",
    tags: [],
    usageCount: 0,
    implementation,
    inputSchema: { type: "object" },
  };
}

export function tamper(brick: BrickArtifact): BrickArtifact {
  if (brick.kind !== "tool") throw new Error("tamper: tool only");
  return { ...brick, implementation: `${brick.implementation}// tampered` };
}

export function reBrandId(brick: BrickArtifact, fakeHex: string): BrickArtifact {
  return { ...brick, id: brickId(`sha256:${fakeHex}`) };
}
