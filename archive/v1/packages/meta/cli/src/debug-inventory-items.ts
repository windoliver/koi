/**
 * Builds debug inventory extra items from CLI-available metadata.
 *
 * The debug instrumentation automatically captures middleware hooks, but
 * tools, skills, channels, engine adapter, and subsystems must be provided
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
  readonly engineAdapter?: string | undefined;
  readonly tools?:
    | readonly { readonly name: string; readonly origin?: string | undefined }[]
    | undefined;
  readonly subsystems?: readonly string[] | undefined;
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

  // Engine adapter
  if (options.engineAdapter !== undefined) {
    items.push({
      name: options.engineAdapter,
      category: "engine",
      enabled: true,
      source: "static",
    });
  }

  // Model (show separately from engine adapter)
  if (options.model !== undefined) {
    items.push({
      name: options.model,
      category: "engine",
      enabled: true,
      source: "manifest",
    });
  }

  // Tools
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

  // Subsystems (nexus, context-arena, forge, harness, scheduler, gateway, etc.)
  if (options.subsystems !== undefined) {
    for (const sub of options.subsystems) {
      items.push({
        name: sub,
        category: "subsystem",
        enabled: true,
        source: "static",
      });
    }
  }

  return items;
}

/** Collect active subsystem names from CLI bootstrap state. */
export function collectActiveSubsystems(state: {
  readonly nexusEnabled?: boolean | undefined;
  readonly forgeEnabled?: boolean | undefined;
  readonly contextArenaEnabled?: boolean | undefined;
  readonly autonomousEnabled?: boolean | undefined;
  readonly gatewayEnabled?: boolean | undefined;
  readonly schedulerEnabled?: boolean | undefined;
  readonly harnessEnabled?: boolean | undefined;
  readonly temporalEnabled?: boolean | undefined;
  readonly sandboxEnabled?: boolean | undefined;
}): readonly string[] {
  const subs: string[] = [];
  if (state.nexusEnabled === true) subs.push("nexus");
  if (state.forgeEnabled === true) subs.push("forge");
  if (state.contextArenaEnabled === true) subs.push("context-arena");
  if (state.autonomousEnabled === true) subs.push("autonomous");
  if (state.gatewayEnabled === true) subs.push("gateway");
  if (state.schedulerEnabled === true) subs.push("scheduler");
  if (state.harnessEnabled === true) subs.push("harness");
  if (state.temporalEnabled === true) subs.push("temporal");
  if (state.sandboxEnabled === true) subs.push("sandbox");
  return subs;
}
