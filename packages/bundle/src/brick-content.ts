/**
 * Brick content extraction — maps brick kind to hashable primary content.
 *
 * Reimplemented within @koi/bundle to avoid L2→L2 dependency on @koi/forge
 * which has the same function. If a new BrickKind is added, update both.
 */

import type { BrickArtifact } from "@koi/core";

/** Extract the primary content string from a brick artifact for ID recomputation. */
export function extractBrickContent(brick: BrickArtifact): string {
  switch (brick.kind) {
    case "tool":
    case "middleware":
    case "channel":
      return brick.implementation;
    case "skill":
      return brick.content;
    case "agent":
      return brick.manifestYaml;
    case "composite":
      return brick.steps.map((s) => s.brickId).join(",");
  }
}
