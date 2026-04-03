/**
 * Bundle import — load bricks from a portable artifact into a ForgeStore.
 *
 * Algorithm:
 * 1. Validate bundle version
 * 2. Verify bundle content hash (detect manifest/brick-list tampering)
 * 3. Validate each brick with validateBrickArtifact()
 * 4. Verify integrity: recompute BrickId from content, compare to stored ID
 * 5. For each valid brick, check-then-save with dedup and trust downgrade
 * 6. Return imported/skipped/errors counts
 */

import type { BrickArtifact, KoiError, Result } from "@koi/core";
import {
  BUNDLE_FORMAT_VERSION,
  DEFAULT_SANDBOXED_POLICY,
  brickId as toBrickId,
  validation,
} from "@koi/core";
import { computeBrickId, computeContentHash, computePipelineBrickId } from "@koi/hash";
import { validateBrickArtifact } from "@koi/validation";

import { extractBrickContent } from "./brick-content.js";
import type { ImportBrickError, ImportBundleConfig, ImportBundleResult } from "./types.js";

/** Downgrade a brick's trust to sandbox and set bundled provenance source. */
function downgradeBrick(brick: BrickArtifact, bundleName: string): BrickArtifact {
  return {
    ...brick,
    origin: "primordial",
    policy: DEFAULT_SANDBOXED_POLICY,
    scope: "agent",
    provenance: {
      ...brick.provenance,
      source: {
        origin: "bundled",
        bundleName,
        bundleVersion: BUNDLE_FORMAT_VERSION,
      },
    },
  };
}

/** Import bricks from an agent bundle into a store with dedup and trust downgrade. */
export async function importBundle(
  config: ImportBundleConfig,
): Promise<Result<ImportBundleResult, KoiError>> {
  const { bundle, store } = config;

  // 1. Validate bundle version
  if (bundle.version !== BUNDLE_FORMAT_VERSION) {
    return {
      ok: false,
      error: validation(
        `Unsupported bundle version "${String(bundle.version)}", expected "${BUNDLE_FORMAT_VERSION}"`,
      ),
    };
  }

  // 2. Verify bundle content hash — detect tampering of manifest or brick list
  const sortedBrickIds = [...bundle.bricks.map((b) => b.id)].sort();
  const expectedHash = computeContentHash({
    manifest: bundle.manifestYaml,
    brickIds: sortedBrickIds,
  });
  if (expectedHash !== bundle.contentHash) {
    return {
      ok: false,
      error: validation(
        `Bundle content hash mismatch: expected ${expectedHash}, got ${bundle.contentHash}`,
      ),
    };
  }

  // 3. Empty bricks is a valid edge case
  if (bundle.bricks.length === 0) {
    return { ok: true, value: { imported: 0, skipped: 0, errors: [] } };
  }

  // 3b. Deduplicate bricks by ID — a bundle may contain the same brick twice
  const seenIds = new Set<string>();
  const uniqueBricks: readonly BrickArtifact[] = bundle.bricks.filter((b) => {
    const id = String(b.id);
    if (seenIds.has(id)) return false;
    seenIds.add(id);
    return true;
  });

  // 4. Validate and verify each brick, then import in parallel
  const importTasks = uniqueBricks.map(
    async (
      rawBrick,
    ): Promise<{
      readonly kind: "imported" | "skipped" | "error";
      readonly error?: ImportBrickError;
    }> => {
      // Validate structure
      const validationResult = validateBrickArtifact(rawBrick, `bundle:${bundle.name}`);
      if (!validationResult.ok) {
        return {
          kind: "error",
          error: { brickId: String(rawBrick.id), reason: validationResult.error.message },
        };
      }

      const brick = validationResult.value;

      // Verify integrity: recompute BrickId from content
      const expectedId =
        brick.kind === "composite"
          ? computePipelineBrickId(
              brick.steps.map((s) => toBrickId(s.brickId)),
              brick.outputKind,
              brick.files,
            )
          : computeBrickId(brick.kind, extractBrickContent(brick), brick.files);
      if (expectedId !== brick.id) {
        return {
          kind: "error",
          error: {
            brickId: brick.id,
            reason: `Integrity check failed: expected ${expectedId}, got ${brick.id}`,
          },
        };
      }

      // Check-then-save with dedup
      const existsResult = await store.exists(brick.id);
      if (!existsResult.ok) {
        return {
          kind: "error",
          error: { brickId: brick.id, reason: existsResult.error.message },
        };
      }

      if (existsResult.value) {
        return { kind: "skipped" };
      }

      // Downgrade trust and save
      const downgraded = downgradeBrick(brick, bundle.name);
      const saveResult = await store.save(downgraded);
      if (!saveResult.ok) {
        return {
          kind: "error",
          error: { brickId: brick.id, reason: saveResult.error.message },
        };
      }

      return { kind: "imported" };
    },
  );

  const results = await Promise.all(importTasks);

  // 5. Aggregate results (immutable)
  const imported = results.filter((r) => r.kind === "imported").length;
  const skipped = results.filter((r) => r.kind === "skipped").length;
  const errors: readonly ImportBrickError[] = results
    .filter(
      (r): r is typeof r & { readonly error: ImportBrickError } =>
        r.kind === "error" && r.error !== undefined,
    )
    .map((r) => r.error);

  return { ok: true, value: { imported, skipped, errors } };
}
