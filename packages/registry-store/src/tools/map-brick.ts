/**
 * Shared BrickArtifact → JsonObject projection helpers.
 *
 * Used by registry_search, registry_get, and registry_install tools
 * to produce summary and full representations of bricks.
 */

import type { BrickArtifact, JsonObject } from "@koi/core";

/** Summary projection — omits implementation, inputSchema, files, provenance, fitness. */
export function mapBrickSummary(brick: BrickArtifact): JsonObject {
  return {
    id: brick.id,
    kind: brick.kind,
    name: brick.name,
    description: brick.description,
    version: brick.version,
    tags: [...brick.tags],
    trustTier: brick.trustTier,
    lifecycle: brick.lifecycle,
    scope: brick.scope,
    usageCount: brick.usageCount,
    ...(brick.requires !== undefined ? { requires: brick.requires as unknown as JsonObject } : {}),
  };
}

/** Kind-specific fields for full projection. */
function mapKindFields(brick: BrickArtifact): JsonObject {
  switch (brick.kind) {
    case "tool":
      return {
        implementation: brick.implementation,
        inputSchema: brick.inputSchema as unknown as JsonObject,
        ...(brick.testCases !== undefined
          ? { testCases: brick.testCases as unknown as JsonObject }
          : {}),
      };
    case "skill":
      return { content: brick.content };
    case "agent":
      return { manifestYaml: brick.manifestYaml };
    case "middleware":
    case "channel":
      return {
        implementation: brick.implementation,
        ...(brick.testCases !== undefined
          ? { testCases: brick.testCases as unknown as JsonObject }
          : {}),
      };
    case "composite":
      return {
        steps: brick.steps as unknown as JsonObject,
        exposedInput: brick.exposedInput as unknown as JsonObject,
        exposedOutput: brick.exposedOutput as unknown as JsonObject,
        outputKind: brick.outputKind,
      };
  }
}

/** Full projection — includes all fields including implementation, schemas, and kind-specific data. */
export function mapBrickFull(brick: BrickArtifact): JsonObject {
  return {
    ...mapBrickSummary(brick),
    ...(brick.files !== undefined ? { files: brick.files as unknown as JsonObject } : {}),
    ...(brick.configSchema !== undefined
      ? { configSchema: brick.configSchema as unknown as JsonObject }
      : {}),
    ...mapKindFields(brick),
  };
}

/** Install summary — lightweight projection for install results (omits usageCount). */
export function mapBrickInstallSummary(brick: BrickArtifact): JsonObject {
  return {
    id: brick.id,
    kind: brick.kind,
    name: brick.name,
    description: brick.description,
    version: brick.version,
    tags: [...brick.tags],
    trustTier: brick.trustTier,
    lifecycle: brick.lifecycle,
    scope: brick.scope,
  };
}
