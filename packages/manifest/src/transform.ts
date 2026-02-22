/**
 * Transforms raw parsed YAML (shorthand formats) into L0-compatible types.
 *
 * Bridges the gap between user-friendly YAML syntax and strict `@koi/core` types.
 */

import type {
  ChannelConfig,
  JsonObject,
  MiddlewareConfig,
  ModelConfig,
  PermissionConfig,
  ToolConfig,
} from "@koi/core";
import type { RawManifest } from "./schema.js";
import type { LoadedManifest } from "./types.js";

/** Narrows an unknown value to JsonObject after a runtime type guard. */
function toJsonObject(value: unknown): JsonObject {
  if (typeof value === "object" && value !== null) {
    return value as JsonObject;
  }
  return {};
}

/**
 * Normalizes model config from string shorthand or object to `ModelConfig`.
 *
 * - `"anthropic:claude-sonnet-4-5-20250929"` → `{ name: "anthropic:claude-sonnet-4-5-20250929" }`
 * - `{ name: "...", options: { ... } }` → passed through
 */
export function normalizeModelConfig(
  raw: string | { readonly name: string; readonly options?: Record<string, unknown> | undefined },
): ModelConfig {
  if (typeof raw === "string") {
    return { name: raw };
  }
  return raw.options !== undefined ? { name: raw.name, options: raw.options } : { name: raw.name };
}

/**
 * A normalized config item compatible with L0's ToolConfig/MiddlewareConfig/ChannelConfig.
 */
interface NormalizedConfig {
  readonly name: string;
  readonly options?: JsonObject;
}

/**
 * Normalizes a config item from either:
 * - `{ name: "...", options: { ... } }` → passed through
 * - `{ "@koi/pkg": { key: value } }` → `{ name: "@koi/pkg", options: { key: value } }`
 */
export function normalizeConfigItem(raw: Readonly<Record<string, unknown>>): NormalizedConfig {
  // If it has a `name` property that's a string, it's already in standard format
  if (typeof raw.name === "string") {
    return raw.options !== undefined
      ? { name: raw.name, options: toJsonObject(raw.options) }
      : { name: raw.name };
  }

  // Key-value format: single key is the package name, value is options
  const keys = Object.keys(raw);
  const key = keys[0];
  if (key === undefined) {
    return { name: "" };
  }

  return { name: key, options: toJsonObject(raw[key]) };
}

/**
 * Flattens a keyed tools section into a flat `ToolConfig[]`.
 *
 * Input: `{ mcp: [{ name: "fs", command: "..." }] }`
 * Output: `[{ name: "fs", options: { command: "...", section: "mcp" } }]`
 */
function flattenToolsSections(
  tools: Readonly<Record<string, readonly Record<string, unknown>[]>>,
): readonly ToolConfig[] {
  return Object.entries(tools).flatMap(([section, items]) =>
    items.map((item): ToolConfig => {
      const normalized = normalizeConfigItem(item);
      const { name: _name, options: _options, ...extraFields } = item;
      const mergedOptions: JsonObject = {
        ...extraFields,
        ...(normalized.options ?? {}),
        section,
      };
      return { name: normalized.name, options: mergedOptions };
    }),
  );
}

/**
 * Converts raw permissions (with possible undefined values) to L0 PermissionConfig.
 * Strips undefined entries to satisfy exactOptionalPropertyTypes.
 */
function normalizePermissions(raw: {
  readonly allow?: readonly string[] | undefined;
  readonly deny?: readonly string[] | undefined;
  readonly ask?: readonly string[] | undefined;
}): PermissionConfig {
  const result: Record<string, readonly string[]> = {};
  if (raw.allow !== undefined) result.allow = raw.allow;
  if (raw.deny !== undefined) result.deny = raw.deny;
  if (raw.ask !== undefined) result.ask = raw.ask;
  return result as PermissionConfig;
}

/**
 * Transforms a validated raw manifest into a `LoadedManifest`.
 */
export function transformToLoadedManifest(raw: RawManifest): LoadedManifest {
  const model = normalizeModelConfig(raw.model);

  // Transform tools — let: assigned conditionally across branches
  let tools: readonly ToolConfig[] | undefined; // let: conditional assignment
  if (raw.tools !== undefined) {
    if (Array.isArray(raw.tools)) {
      tools = raw.tools.map((t): ToolConfig => normalizeConfigItem(t));
    } else {
      // After Array.isArray narrowing, this is the keyed-sections Record format
      const keyedTools = raw.tools as Readonly<Record<string, readonly Record<string, unknown>[]>>;
      tools = flattenToolsSections(keyedTools);
    }
  }

  // Transform middleware
  const middleware: readonly MiddlewareConfig[] | undefined = raw.middleware?.map(
    (m): MiddlewareConfig => normalizeConfigItem(m),
  );

  // Transform channels
  const channels: readonly ChannelConfig[] | undefined = raw.channels?.map(
    (c): ChannelConfig => normalizeConfigItem(c),
  );

  // Build base manifest with required fields
  const base = { name: raw.name, version: raw.version, model };

  // Build result — only include defined properties to satisfy exactOptionalPropertyTypes
  const manifest: LoadedManifest = {
    ...base,
    ...(raw.description !== undefined ? { description: raw.description } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(channels !== undefined ? { channels } : {}),
    ...(middleware !== undefined ? { middleware } : {}),
    ...(raw.permissions !== undefined
      ? { permissions: normalizePermissions(raw.permissions) }
      : {}),
    ...(raw.metadata !== undefined ? { metadata: raw.metadata } : {}),
    // Extension fields
    ...(raw.engine !== undefined ? { engine: raw.engine } : {}),
    ...(raw.schedule !== undefined ? { schedule: raw.schedule } : {}),
    ...(raw.webhooks !== undefined ? { webhooks: raw.webhooks } : {}),
    ...(raw.forge !== undefined ? { forge: raw.forge } : {}),
  };

  return manifest;
}
