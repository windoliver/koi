/**
 * list_playbooks tool — exposes learned playbooks to the agent.
 *
 * Thin wrapper around PlaybookStore.list() with optional
 * StructuredPlaybookStore support, limit/sort, and input validation.
 */

import type { JsonObject, Tool, ToolPolicy } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import type { PlaybookStore, StructuredPlaybookStore } from "../stores.js";
import type { Playbook, StructuredPlaybook } from "../types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ListPlaybooksToolConfig {
  readonly playbookStore: PlaybookStore;
  readonly structuredPlaybookStore?: StructuredPlaybookStore | undefined;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createListPlaybooksTool(config: ListPlaybooksToolConfig): Tool {
  return {
    descriptor: {
      name: "list_playbooks",
      description:
        "List learned playbooks from ACE training. Shows patterns the agent has learned " +
        "across sessions with confidence scores. Use to inspect your own learning before " +
        "deciding what to forge into reusable skills or tools.",
      inputSchema: {
        type: "object",
        properties: {
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Filter by tags (returns playbooks matching ANY tag)",
          },
          minConfidence: {
            type: "number",
            minimum: 0,
            maximum: 1,
            description:
              "Minimum confidence threshold (0-1). Applies to stat-based playbooks only. Default: 0",
          },
          limit: {
            type: "number",
            minimum: 1,
            maximum: MAX_LIMIT,
            description: `Max results returned, sorted by confidence descending. Default: ${String(DEFAULT_LIMIT)}`,
          },
        },
      },
    },
    origin: "primordial",
    policy: DEFAULT_UNSANDBOXED_POLICY satisfies ToolPolicy,
    execute: async (args: JsonObject): Promise<unknown> => {
      const tags = validateTags(args.tags);
      const minConfidence = validateMinConfidence(args.minConfidence);
      const limit = validateLimit(args.limit);

      try {
        // Prefer structured playbooks when available
        if (config.structuredPlaybookStore !== undefined) {
          const structured = await config.structuredPlaybookStore.list(
            tags !== undefined ? { tags } : undefined,
          );
          // StructuredPlaybookStore doesn't filter by minConfidence natively —
          // structured playbooks use bullet-level confidence, not top-level.
          // Sort by sessionCount descending (proxy for confidence in structured mode).
          const sorted = [...structured].sort((a, b) => b.sessionCount - a.sessionCount);
          return formatStructuredResult(sorted.slice(0, limit));
        }

        // Fall back to stat-based playbooks
        const playbooks = await config.playbookStore.list({
          ...(tags !== undefined ? { tags } : {}),
          ...(minConfidence !== undefined ? { minConfidence } : {}),
        });
        const sorted = [...playbooks].sort((a, b) => b.confidence - a.confidence);
        return formatStatResult(sorted.slice(0, limit));
      } catch (e: unknown) {
        return {
          error: e instanceof Error ? e.message : String(e),
          code: "INTERNAL",
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function validateTags(raw: unknown): readonly string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) return undefined;
  const filtered = raw.filter((item): item is string => typeof item === "string");
  return filtered.length > 0 ? filtered : undefined;
}

function validateMinConfidence(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  return Math.max(0, Math.min(1, raw));
}

function validateLimit(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_LIMIT;
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    return DEFAULT_LIMIT;
  }
  return Math.max(1, Math.min(MAX_LIMIT, raw));
}

// ---------------------------------------------------------------------------
// Result formatting
// ---------------------------------------------------------------------------

interface StatPlaybookResult {
  readonly id: string;
  readonly title: string;
  readonly strategy: string;
  readonly confidence: number;
  readonly tags: readonly string[];
  readonly sessionCount: number;
  readonly source: string;
}

function formatStatResult(playbooks: readonly Playbook[]): {
  readonly kind: "stat";
  readonly count: number;
  readonly playbooks: readonly StatPlaybookResult[];
} {
  return {
    kind: "stat",
    count: playbooks.length,
    playbooks: playbooks.map((pb) => ({
      id: pb.id,
      title: pb.title,
      strategy: pb.strategy,
      confidence: pb.confidence,
      tags: pb.tags,
      sessionCount: pb.sessionCount,
      source: pb.source,
    })),
  };
}

interface StructuredPlaybookResult {
  readonly id: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly sessionCount: number;
  readonly sections: readonly {
    readonly name: string;
    readonly bulletCount: number;
    readonly bullets: readonly {
      readonly id: string;
      readonly content: string;
      readonly helpful: number;
      readonly harmful: number;
    }[];
  }[];
}

function formatStructuredResult(playbooks: readonly StructuredPlaybook[]): {
  readonly kind: "structured";
  readonly count: number;
  readonly playbooks: readonly StructuredPlaybookResult[];
} {
  return {
    kind: "structured",
    count: playbooks.length,
    playbooks: playbooks.map((pb) => ({
      id: pb.id,
      title: pb.title,
      tags: pb.tags,
      sessionCount: pb.sessionCount,
      sections: pb.sections.map((section) => ({
        name: section.name,
        bulletCount: section.bullets.length,
        bullets: section.bullets.map((b) => ({
          id: b.id,
          content: b.content,
          helpful: b.helpful,
          harmful: b.harmful,
        })),
      })),
    })),
  };
}
