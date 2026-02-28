/**
 * Source adapters — map external registries to the CatalogSourceAdapter interface.
 *
 * Each adapter normalizes a specific source (forge, skill, bundled, MCP)
 * into CatalogEntry objects with source-prefixed names.
 */

import type {
  BrickArtifact,
  BrickRegistryReader,
  CatalogEntry,
  CatalogQuery,
  CatalogSource,
  Resolver,
  SkillRegistryEntry,
  SkillRegistryReader,
  Tool,
  ToolDescriptor,
} from "@koi/core";

import type { CatalogSourceAdapter } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function prefixName(source: CatalogSource, name: string): string {
  return `${source}:${name}`;
}

function matchesText(text: string, entry: CatalogEntry): boolean {
  const lower = text.toLowerCase();
  return (
    entry.name.toLowerCase().includes(lower) || entry.description.toLowerCase().includes(lower)
  );
}

function matchesTags(tags: readonly string[], entry: CatalogEntry): boolean {
  const entryTags = entry.tags;
  if (entryTags === undefined) return false;
  return tags.every((tag) => entryTags.includes(tag));
}

function matchesKind(query: CatalogQuery, entry: CatalogEntry): boolean {
  if (query.kind === undefined) return true;
  return entry.kind === query.kind;
}

function filterEntries(
  query: CatalogQuery,
  entries: readonly CatalogEntry[],
): readonly CatalogEntry[] {
  return entries.filter((entry) => {
    if (!matchesKind(query, entry)) return false;
    if (query.text !== undefined && !matchesText(query.text, entry)) return false;
    if (query.tags !== undefined && query.tags.length > 0 && !matchesTags(query.tags, entry))
      return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Forge adapter
// ---------------------------------------------------------------------------

function mapBrickToEntry(brick: BrickArtifact): CatalogEntry {
  return {
    name: prefixName("forged", brick.name),
    kind: brick.kind,
    source: "forged",
    description: brick.description,
    ...(brick.trustTier !== undefined ? { trustTier: brick.trustTier } : {}),
    ...(brick.tags.length > 0 ? { tags: brick.tags } : {}),
    ...(brick.version !== undefined ? { version: brick.version } : {}),
  };
}

export function createForgeAdapter(store: BrickRegistryReader): CatalogSourceAdapter {
  const search = async (query: CatalogQuery): Promise<readonly CatalogEntry[]> => {
    const page = await store.search({
      ...(query.kind !== undefined ? { kind: query.kind } : {}),
      ...(query.text !== undefined ? { text: query.text } : {}),
      ...(query.tags !== undefined ? { tags: [...query.tags] } : {}),
    });
    return page.items.map(mapBrickToEntry);
  };

  const storeOnChange = store.onChange;
  const onChange =
    storeOnChange !== undefined
      ? (listener: () => void): (() => void) => storeOnChange(() => listener())
      : undefined;

  return { source: "forged", search, ...(onChange !== undefined ? { onChange } : {}) };
}

// ---------------------------------------------------------------------------
// Skill adapter
// ---------------------------------------------------------------------------

function mapSkillToEntry(entry: SkillRegistryEntry): CatalogEntry {
  return {
    name: prefixName("skill-registry", entry.name),
    kind: "skill",
    source: "skill-registry",
    description: entry.description,
    version: entry.version,
    tags: entry.tags,
  };
}

export function createSkillAdapter(registry: SkillRegistryReader): CatalogSourceAdapter {
  const search = async (query: CatalogQuery): Promise<readonly CatalogEntry[]> => {
    // Skills are always kind "skill" — skip if query asks for another kind
    if (query.kind !== undefined && query.kind !== "skill") return [];

    const page = await registry.search({
      ...(query.text !== undefined ? { text: query.text } : {}),
      ...(query.tags !== undefined ? { tags: [...query.tags] } : {}),
    });
    return page.items.map(mapSkillToEntry);
  };

  const registryOnChange = registry.onChange;
  const onChange =
    registryOnChange !== undefined
      ? (listener: () => void): (() => void) => registryOnChange(() => listener())
      : undefined;

  return { source: "skill-registry", search, ...(onChange !== undefined ? { onChange } : {}) };
}

// ---------------------------------------------------------------------------
// Bundled adapter (static entries, client-side filtering)
// ---------------------------------------------------------------------------

export function createBundledAdapter(entries: readonly CatalogEntry[]): CatalogSourceAdapter {
  const search = async (query: CatalogQuery): Promise<readonly CatalogEntry[]> => {
    return filterEntries(query, entries);
  };

  return { source: "bundled", search };
}

// ---------------------------------------------------------------------------
// MCP adapter
// ---------------------------------------------------------------------------

function mapToolDescriptorToEntry(descriptor: ToolDescriptor): CatalogEntry {
  return {
    name: prefixName("mcp", descriptor.name),
    kind: "tool",
    source: "mcp",
    description: descriptor.description,
  };
}

export function createMcpAdapter(resolver: Resolver<ToolDescriptor, Tool>): CatalogSourceAdapter {
  const search = async (query: CatalogQuery): Promise<readonly CatalogEntry[]> => {
    // MCP tools are always kind "tool" — skip if query asks for another kind
    if (query.kind !== undefined && query.kind !== "tool") return [];

    const descriptors = await resolver.discover();
    const entries = descriptors.map(mapToolDescriptorToEntry);
    return filterEntries(query, entries);
  };

  const resolverOnChange = resolver.onChange;
  const onChange =
    resolverOnChange !== undefined
      ? (listener: () => void): (() => void) => resolverOnChange(listener)
      : undefined;

  return { source: "mcp", search, ...(onChange !== undefined ? { onChange } : {}) };
}
