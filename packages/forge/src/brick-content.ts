/**
 * Shared brick content extraction — maps brick kind to hashable primary content.
 *
 * Used by both integrity verification and forge pipeline for content-addressed ID computation.
 */

import type { BrickKind } from "@koi/core";

/**
 * Minimal shape needed for content extraction — works for full BrickArtifact
 * and provenance-less builder output.
 */
interface HasKindAndContent {
  readonly kind: BrickKind;
  readonly implementation?: string;
  readonly content?: string;
  readonly manifestYaml?: string;
  readonly steps?: readonly { readonly brickId: string }[];
}

/**
 * Extract the primary content string from a brick artifact for hashing.
 */
export function extractBrickContent(brick: HasKindAndContent): {
  readonly kind: string;
  readonly content: string;
} {
  switch (brick.kind) {
    case "tool":
    case "middleware":
    case "channel":
      return { kind: brick.kind, content: brick.implementation ?? "" };
    case "skill":
      return { kind: brick.kind, content: brick.content ?? "" };
    case "agent":
      return { kind: brick.kind, content: brick.manifestYaml ?? "" };
    case "composite":
      return {
        kind: brick.kind,
        content: brick.steps?.map((s) => s.brickId).join(",") ?? "",
      };
  }
}
