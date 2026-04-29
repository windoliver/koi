/**
 * Map a brick to its hashable primary content.
 *
 * Used by integrity verification — recomputing the content-addressed
 * `BrickId` requires the same kind+content pair the producer hashed.
 */

import type { BrickKind } from "@koi/core";

interface HasKindAndContent {
  readonly kind: BrickKind;
  readonly implementation?: string;
  readonly content?: string;
  readonly manifestYaml?: string;
  readonly steps?: readonly { readonly brickId: string }[];
}

export interface BrickContent {
  readonly kind: BrickKind;
  readonly content: string;
}

export function extractBrickContent(brick: HasKindAndContent): BrickContent {
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
