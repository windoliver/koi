/**
 * mapBrickToIndexDoc — maps a BrickArtifact to an IndexDocument for search indexing.
 *
 * Pure function: no side effects, no I/O. Used by the indexing subscriber
 * in @koi/forge (L3) to keep the search index in sync with the forge store.
 */

import type { BrickArtifact } from "@koi/core";
import type { IndexDocument } from "@koi/search-provider";

/**
 * Extracts extra content from a brick based on its kind:
 * - tool: inputSchema property keys
 * - skill: first paragraph of SKILL.md from brick.files
 * - others: empty string
 */
function extractExtraContent(brick: BrickArtifact): string {
  switch (brick.kind) {
    case "tool": {
      const props = brick.inputSchema.properties;
      if (props !== null && typeof props === "object" && !Array.isArray(props)) {
        return Object.keys(props as Record<string, unknown>).join(" ");
      }
      return "";
    }
    case "skill": {
      if (brick.files === undefined) return "";
      const skillMd = brick.files["SKILL.md"];
      if (skillMd === undefined) return "";
      // Extract first paragraph: text before the first blank line
      const firstParagraph = skillMd.split(/\n\s*\n/)[0];
      return firstParagraph?.trim() ?? "";
    }
    default:
      return "";
  }
}

/**
 * Maps a BrickArtifact to an IndexDocument for hybrid search indexing.
 *
 * - `id`: brick.id (content-addressed, used for dedup on re-index)
 * - `content`: concatenation of name, description, tags, and kind-specific extra content
 * - `metadata`: kind, scope, lifecycle, tags (used for post-retrieval filtering)
 */
export function mapBrickToIndexDoc(brick: BrickArtifact): IndexDocument {
  const parts = [brick.name, brick.description];

  if (brick.tags.length > 0) {
    parts.push(brick.tags.join(" "));
  }

  if (brick.trigger !== undefined && brick.trigger.length > 0) {
    parts.push(brick.trigger.join(" "));
  }

  const extra = extractExtraContent(brick);
  if (extra.length > 0) {
    parts.push(extra);
  }

  return {
    id: brick.id,
    content: parts.join(" "),
    metadata: {
      kind: brick.kind,
      scope: brick.scope,
      lifecycle: brick.lifecycle,
      tags: brick.tags,
    },
  };
}
