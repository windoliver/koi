/**
 * Transforms raw parsed YAML (shorthand formats) into L0-compatible types.
 *
 * Bridges the gap between user-friendly YAML syntax and strict `@koi/core` types.
 */

import type {
  ChannelConfig,
  ChannelIdentity,
  DegeneracyConfig,
  DeliveryPolicy,
  JsonObject,
  MiddlewareConfig,
  ModelConfig,
  OutboundWebhookConfig,
  PermissionConfig,
  SkillConfig,
  SkillSource,
  ToolConfig,
  WebhookEventKind,
} from "@koi/core";
import { brickId } from "@koi/core";
import type { RawManifest } from "./schema.js";
import type { DeployConfig, LoadedManifest } from "./types.js";

/** Narrows an unknown value to JsonObject after a runtime type guard. */
function toJsonObject(value: unknown): JsonObject {
  if (typeof value === "object" && value !== null) {
    return value as JsonObject;
  }
  return {};
}

/** Extension field names that pass through from raw YAML to LoadedManifest. */
const EXTENSION_FIELDS = [
  "engine",
  "schedule",
  "webhooks",
  "forge",
  "context",
  "soul",
  "user",
  "scope",
  "preset",
  "demo",
  "nexus",
  "codeSandbox",
  "dataSources",
  "autonomous",
] as const;

/**
 * Extracts defined extension fields from a raw manifest into a partial object.
 * Only includes fields that are explicitly present (not undefined) to satisfy
 * `exactOptionalPropertyTypes`.
 */
export function extractExtensions(
  raw: Readonly<Record<string, unknown>>,
  fieldNames: readonly string[] = EXTENSION_FIELDS,
): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const field of fieldNames) {
    if (raw[field] !== undefined) {
      result[field] = raw[field];
    }
  }
  return result;
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
  readonly version?: string;
  readonly publisher?: string;
}

/**
 * Normalizes a config item from either:
 * - `{ name: "...", options: { ... } }` → passed through
 * - `{ "@koi/pkg": { key: value } }` → `{ name: "@koi/pkg", options: { key: value } }`
 */
export function normalizeConfigItem(raw: Readonly<Record<string, unknown>>): NormalizedConfig {
  // If it has a `name` property that's a string, it's already in standard format
  if (typeof raw.name === "string") {
    const base: NormalizedConfig =
      raw.options !== undefined
        ? { name: raw.name, options: toJsonObject(raw.options) }
        : { name: raw.name };
    return {
      ...base,
      ...(typeof raw.version === "string" ? { version: raw.version } : {}),
      ...(typeof raw.publisher === "string" ? { publisher: raw.publisher } : {}),
    };
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
 * Normalizes a middleware config item, preserving the `required` flag if present.
 * Extends `normalizeConfigItem` with required passthrough.
 */
export function normalizeMiddlewareConfig(
  raw: Readonly<Record<string, unknown>>,
): MiddlewareConfig {
  const base = normalizeConfigItem(raw);
  if (typeof raw.required === "boolean") {
    return { ...base, required: raw.required };
  }
  return base;
}

/**
 * Normalizes a channel config item, preserving the `identity` block if present.
 * Extends `normalizeConfigItem` with identity passthrough.
 */
export function normalizeChannelConfig(raw: Readonly<Record<string, unknown>>): ChannelConfig {
  const base = normalizeConfigItem(raw);
  if (typeof raw.identity === "object" && raw.identity !== null) {
    const id = raw.identity as Readonly<Record<string, unknown>>;
    const identity: ChannelIdentity = {
      ...(typeof id.name === "string" ? { name: id.name } : {}),
      ...(typeof id.avatar === "string" ? { avatar: id.avatar } : {}),
      ...(typeof id.instructions === "string" ? { instructions: id.instructions } : {}),
    };
    return {
      ...base,
      identity,
      ...(typeof raw.version === "string" ? { version: raw.version } : {}),
      ...(typeof raw.publisher === "string" ? { publisher: raw.publisher } : {}),
    };
  }
  return base;
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
      const {
        name: _name,
        options: _options,
        version: _version,
        publisher: _publisher,
        ...extraFields
      } = item;
      const mergedOptions: JsonObject = {
        ...extraFields,
        ...(normalized.options ?? {}),
        section,
      };
      return {
        name: normalized.name,
        options: mergedOptions,
        ...(normalized.version !== undefined ? { version: normalized.version } : {}),
        ...(normalized.publisher !== undefined ? { publisher: normalized.publisher } : {}),
      };
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
 * Maps a raw skill source (Zod-inferred) to an L0 SkillSource (branded BrickId).
 */
function mapSkillSource(
  raw:
    | { readonly kind: "filesystem"; readonly path: string }
    | { readonly kind: "forged"; readonly brickId: string },
): SkillSource {
  switch (raw.kind) {
    case "filesystem":
      return { kind: "filesystem", path: raw.path };
    case "forged":
      return { kind: "forged", brickId: brickId(raw.brickId) };
  }
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

  // Transform middleware — preserves `required` flag when present
  const middleware: readonly MiddlewareConfig[] | undefined = raw.middleware?.map(
    (m): MiddlewareConfig => normalizeMiddlewareConfig(m),
  );

  // Transform channels — preserve identity block if present
  const channels: readonly ChannelConfig[] | undefined = raw.channels?.map(
    (c): ChannelConfig => normalizeChannelConfig(c),
  );

  // Transform skills — map RawSkillSource → L0 SkillSource (branded BrickId)
  const skills: readonly SkillConfig[] | undefined = raw.skills?.map(
    (s): SkillConfig => ({
      name: s.name,
      source: mapSkillSource(s.source),
      ...(s.options !== undefined ? { options: toJsonObject(s.options) } : {}),
    }),
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
    ...(skills !== undefined ? { skills } : {}),
    ...(raw.permissions !== undefined
      ? { permissions: normalizePermissions(raw.permissions) }
      : {}),
    ...(raw.metadata !== undefined ? { metadata: raw.metadata } : {}),
    ...(raw.outboundWebhooks !== undefined
      ? {
          outboundWebhooks: raw.outboundWebhooks.map(
            (w): OutboundWebhookConfig => ({
              url: w.url,
              events: w.events as readonly WebhookEventKind[],
              secret: w.secret,
              ...(w.description !== undefined ? { description: w.description } : {}),
              ...(w.enabled !== undefined ? { enabled: w.enabled } : {}),
            }),
          ),
        }
      : {}),
    // Extension fields (engine, schedule, webhooks, forge, context, deploy)
    ...extractExtensions(raw as unknown as Readonly<Record<string, unknown>>),
    ...(raw.deploy !== undefined ? { deploy: raw.deploy as DeployConfig } : {}),
    ...(raw.degeneracy !== undefined
      ? { degeneracy: raw.degeneracy as Readonly<Record<string, DegeneracyConfig>> }
      : {}),
    ...(raw.delivery !== undefined ? { delivery: raw.delivery as DeliveryPolicy } : {}),
    ...(raw.agents !== undefined ? { agents: raw.agents } : {}),
  };

  return manifest;
}
