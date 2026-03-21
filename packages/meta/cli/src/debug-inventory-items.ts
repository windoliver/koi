/**
 * Builds debug inventory extra items from CLI-available metadata.
 *
 * The debug instrumentation automatically captures middleware, but
 * tools, skills, channels, and engine identity must be provided
 * explicitly since they're resolved outside the compose layer.
 */

import type { DebugInventoryItem } from "@koi/engine";

const VALID_SOURCES: ReadonlySet<string> = new Set([
  "static",
  "forged",
  "dynamic",
  "operator",
  "manifest",
]);

function isValidSource(value: string | undefined): value is DebugInventoryItem["source"] {
  return value !== undefined && VALID_SOURCES.has(value);
}

/** Build extra inventory items for the debug view from CLI metadata. */
export function buildDebugExtraItems(options: {
  readonly channels: readonly string[];
  readonly skills: readonly string[];
  readonly model?: string | undefined;
  readonly tools?:
    | readonly { readonly name: string; readonly origin?: string | undefined }[]
    | undefined;
}): readonly DebugInventoryItem[] {
  const items: DebugInventoryItem[] = [];

  // Channels
  for (const ch of options.channels) {
    items.push({
      name: ch,
      category: "channel",
      enabled: true,
      source: "manifest",
    });
  }

  // Skills
  for (const sk of options.skills) {
    items.push({
      name: sk,
      category: "skill",
      enabled: true,
      source: "manifest",
    });
  }

  // Engine / model
  if (options.model !== undefined) {
    items.push({
      name: options.model,
      category: "engine",
      enabled: true,
      source: "manifest",
    });
  }

  // Tools (if provided)
  if (options.tools !== undefined) {
    for (const tool of options.tools) {
      items.push({
        name: tool.name,
        category: "tool",
        enabled: true,
        source: isValidSource(tool.origin) ? tool.origin : "manifest",
      });
    }
  }

  return items;
}
