/**
 * search_catalog tool — agent-callable unified search across all catalog sources.
 *
 * Queries the CatalogReader and enriches results with `installed` status
 * by checking the agent's component map.
 */

import type {
  Agent,
  BrickKind,
  CatalogEntry,
  CatalogReader,
  CatalogSource,
  CatalogSourceError,
  JsonObject,
  Tool,
} from "@koi/core";
import { ALL_BRICK_KINDS, ALL_CATALOG_SOURCES, DEFAULT_SANDBOXED_POLICY } from "@koi/core";

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

interface SearchInput {
  readonly kind?: BrickKind;
  readonly text?: string;
  readonly source?: CatalogSource;
  readonly tags?: readonly string[];
  readonly limit?: number;
}

const VALID_KINDS: ReadonlySet<string> = new Set(ALL_BRICK_KINDS);
const VALID_SOURCES: ReadonlySet<string> = new Set(ALL_CATALOG_SOURCES);

function parseInput(args: JsonObject): SearchInput {
  const rawKind = args.kind;
  const rawSource = args.source;

  return {
    ...(typeof rawKind === "string" && VALID_KINDS.has(rawKind)
      ? { kind: rawKind as BrickKind }
      : {}),
    ...(typeof args.text === "string" ? { text: args.text } : {}),
    ...(typeof rawSource === "string" && VALID_SOURCES.has(rawSource)
      ? { source: rawSource as CatalogSource }
      : {}),
    ...(Array.isArray(args.tags) ? { tags: args.tags as readonly string[] } : {}),
    ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
  };
}

// ---------------------------------------------------------------------------
// Installed check
// ---------------------------------------------------------------------------

function isInstalled(agent: Agent, entryName: string): boolean {
  // Strip the source prefix to get the base name
  const colonIndex = entryName.indexOf(":");
  const baseName = colonIndex >= 0 ? entryName.slice(colonIndex + 1) : entryName;

  // Check all component prefixes (tool:, skill:, middleware:, channel:, agent:)
  const components = agent.components();
  for (const key of components.keys()) {
    if (key.endsWith(`:${baseName}`) || key === baseName) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createSearchCatalogTool(reader: CatalogReader, agent: Agent): Tool {
  return {
    descriptor: {
      name: "search_catalog",
      description:
        "Search the unified capability catalog across bundled packages, forged bricks, MCP tools, and skill registry. " +
        "Use this to discover available tools, skills, middleware, and channels before using attach_capability.",
      inputSchema: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            description: "Filter by capability kind",
            enum: ["tool", "skill", "agent", "middleware", "channel"],
          },
          text: {
            type: "string",
            description: "Free-text search against name and description",
          },
          source: {
            type: "string",
            description: "Filter by source",
            enum: ["bundled", "forged", "mcp", "skill-registry"],
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Filter by tags (AND — all must match)",
          },
          limit: {
            type: "number",
            description: "Maximum results to return (default: 50)",
          },
        },
        additionalProperties: false,
      },
    },
    origin: "primordial",
    policy: DEFAULT_SANDBOXED_POLICY,
    execute: async (args: JsonObject): Promise<unknown> => {
      const input = parseInput(args);
      const page = await reader.search({
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.source !== undefined ? { source: input.source } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      });

      const enriched = page.items.map((entry: CatalogEntry) => ({
        ...entry,
        installed: isInstalled(agent, entry.name),
      }));

      return {
        items: enriched,
        total: page.total,
        ...(page.sourceErrors !== undefined && page.sourceErrors.length > 0
          ? {
              sourceErrors: page.sourceErrors.map((se: CatalogSourceError) => ({
                source: se.source,
                error: se.error.message,
              })),
            }
          : {}),
      };
    },
  };
}
