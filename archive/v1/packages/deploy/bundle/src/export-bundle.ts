/**
 * Bundle export — serialize an agent's manifest + bricks into a portable artifact.
 *
 * Algorithm:
 * 1. Validate inputs (name, manifestYaml, brickIds non-empty)
 * 2. Deduplicate brick IDs
 * 3. Load all bricks in parallel from ForgeStore
 * 4. Verify integrity of each loaded brick
 * 5. Compute content hash for the bundle envelope
 * 6. Return AgentBundle
 */

import type { AgentBundle, BrickArtifact, KoiError, Result } from "@koi/core";
import { BUNDLE_FORMAT_VERSION, brickId, bundleId, notFound, validation } from "@koi/core";
import { computeBrickId, computeContentHash, computePipelineBrickId } from "@koi/hash";

import { extractBrickContent } from "./brick-content.js";
import type { ExportBundleConfig } from "./types.js";

/** Create a portable agent bundle from a manifest + brick IDs. */
export async function createBundle(
  config: ExportBundleConfig,
): Promise<Result<AgentBundle, KoiError>> {
  // 1. Validate inputs
  if (config.name.length === 0) {
    return { ok: false, error: validation("Bundle name must not be empty") };
  }
  if (config.manifestYaml.length === 0) {
    return { ok: false, error: validation("Manifest YAML must not be empty") };
  }
  if (config.brickIds.length === 0) {
    return { ok: false, error: validation("At least one brick ID is required") };
  }

  // 2. Deduplicate brick IDs
  const uniqueIds = [...new Set(config.brickIds)];

  // 3. Load all bricks in parallel
  const loadResults = await Promise.all(uniqueIds.map((id) => config.store.load(brickId(id))));

  // 4. Collect bricks, fail on missing — propagate non-NOT_FOUND errors immediately
  const bricks: BrickArtifact[] = [];
  const missingIds: string[] = [];

  for (let i = 0; i < loadResults.length; i++) {
    const result = loadResults[i];
    if (result === undefined) continue;
    if (!result.ok) {
      // Propagate store/I/O errors (INTERNAL, TIMEOUT, etc.) without masking as NOT_FOUND
      if (result.error.code !== "NOT_FOUND") {
        return { ok: false, error: result.error };
      }
      const id = uniqueIds[i];
      if (id !== undefined) {
        missingIds.push(id);
      }
    } else {
      bricks.push(result.value);
    }
  }

  if (missingIds.length > 0) {
    return {
      ok: false,
      error: notFound(missingIds.join(", "), `Bricks not found in store: ${missingIds.join(", ")}`),
    };
  }

  // 5. Verify integrity of each brick
  for (const brick of bricks) {
    const expectedId =
      brick.kind === "composite"
        ? computePipelineBrickId(
            brick.steps.map((s) => brickId(s.brickId)),
            brick.outputKind,
            brick.files,
          )
        : computeBrickId(brick.kind, extractBrickContent(brick), brick.files);
    if (expectedId !== brick.id) {
      return {
        ok: false,
        error: validation(`Brick integrity check failed for ${brick.id}: expected ${expectedId}`),
      };
    }
  }

  // 6. Compute bundle content hash
  const sortedBrickIds = [...bricks.map((b) => b.id)].sort();
  const contentHash = computeContentHash({
    manifest: config.manifestYaml,
    brickIds: sortedBrickIds,
  });

  const id = bundleId(`bundle:${contentHash}`);

  const bundle: AgentBundle = {
    version: BUNDLE_FORMAT_VERSION,
    id,
    name: config.name,
    description: config.description,
    manifestYaml: config.manifestYaml,
    bricks,
    contentHash,
    createdAt: Date.now(),
    ...(config.metadata !== undefined ? { metadata: config.metadata } : {}),
  };

  return { ok: true, value: bundle };
}
