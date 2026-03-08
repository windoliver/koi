/**
 * Brick content extraction — maps brick kind to hashable primary content.
 *
 * Reimplemented within @koi/bundle to avoid L2→L2 dependency on @koi/forge
 * which has the same function. If a new BrickKind is added, update both.
 */

import type { BrickArtifact } from "@koi/core";

/**
 * Extract the primary content string from a brick artifact for ID recomputation.
 * For non-composite kinds only — composite bricks need special handling via
 * computePipelineBrickId (which includes outputKind in the hash).
 */
export function extractBrickContent(
  brick: Exclude<BrickArtifact, { readonly kind: "composite" }>,
): string {
  switch (brick.kind) {
    case "tool":
    case "middleware":
    case "channel":
      return brick.implementation;
    case "skill":
      return brick.content;
    case "agent":
      return brick.manifestYaml;
  }
}
