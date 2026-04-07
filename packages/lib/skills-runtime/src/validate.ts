/**
 * Zod schema for SKILL.md frontmatter validation.
 *
 * Decision 8A: use Zod .transform() to normalize `allowed-tools`
 * (YAML key with hyphen) → `allowedTools` (camelCase TypeScript field).
 * This eliminates manual optional-field spreading in the loader.
 */

import type { KoiError, Result, SkillExecutionMode } from "@koi/core";
import { validateWith } from "@koi/validation";
import { z } from "zod";
import type { ValidatedFrontmatter, ValidatedSkillRequires } from "./types.js";

// ---------------------------------------------------------------------------
// Requires sub-schema
// ---------------------------------------------------------------------------

const requiresSchema = z.object({
  bins: z.array(z.string()).optional(),
  env: z.array(z.string()).optional(),
  tools: z.array(z.string()).optional(),
  network: z.boolean().optional(),
  platform: z.array(z.string()).optional(),
});

// ---------------------------------------------------------------------------
// Frontmatter schema with .transform() for camelCase normalization
// ---------------------------------------------------------------------------

/** Valid execution modes for skills. */
const EXECUTION_MODES = new Set<string>(["inline", "fork"]);

const frontmatterSchema = z
  .object({
    name: z.string().min(1, "name must not be empty"),
    description: z.string().min(1, "description must not be empty"),
    license: z.string().optional(),
    compatibility: z.string().optional(),
    // YAML key uses hyphen: `allowed-tools`
    "allowed-tools": z.union([z.string(), z.array(z.string())]).optional(),
    tags: z.array(z.string()).optional(),
    requires: requiresSchema.optional(),
    // Execution mode: "inline" (default) or "fork"
    execution: z.string().optional(),
    // Catch-all for extra string fields (e.g., version, author)
    // Handled separately after base parse
  })
  .passthrough()
  .transform((raw) => {
    // Normalize `allowed-tools` → `allowedTools` (string or array → string[])
    const rawAllowedTools = raw["allowed-tools"];
    // let: allowedTools may be set below
    let allowedTools: readonly string[] | undefined;
    if (typeof rawAllowedTools === "string") {
      allowedTools = rawAllowedTools
        .split(/\s+/)
        .map((t: string) => t.trim())
        .filter((t: string) => t.length > 0);
    } else if (Array.isArray(rawAllowedTools)) {
      allowedTools = rawAllowedTools.filter((t: unknown): t is string => typeof t === "string");
    }

    // Normalize tags: filter to strings
    const rawTags = raw.tags;
    const tags: readonly string[] | undefined = Array.isArray(rawTags)
      ? rawTags.filter((t: unknown): t is string => typeof t === "string")
      : undefined;

    // Normalize execution mode
    const rawExecution = raw.execution;
    const executionMode: SkillExecutionMode | undefined =
      typeof rawExecution === "string" && EXECUTION_MODES.has(rawExecution)
        ? (rawExecution as SkillExecutionMode)
        : undefined;

    // Collect extra string metadata fields (exclude known keys)
    const knownKeys = new Set([
      "name",
      "description",
      "license",
      "compatibility",
      "allowed-tools",
      "tags",
      "requires",
      "includes",
      "execution",
    ]);
    const metadata: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (!knownKeys.has(key) && typeof value === "string") {
        metadata[key] = value;
      }
    }

    return {
      name: raw.name,
      description: raw.description,
      license: raw.license,
      compatibility: raw.compatibility,
      allowedTools: allowedTools,
      tags: tags,
      requires: raw.requires as ValidatedSkillRequires | undefined,
      metadata:
        Object.keys(metadata).length > 0
          ? (metadata as Readonly<Record<string, string>>)
          : undefined,
      executionMode,
    };
  });

// Re-export for backwards compat — canonical definition is in types.ts
export type { ValidatedFrontmatter } from "./types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validates and transforms raw YAML frontmatter into a typed ValidatedFrontmatter.
 *
 * The transform normalizes `allowed-tools` → `allowedTools` and collects
 * extra string fields into `metadata`.
 */
export function validateFrontmatter(
  raw: Readonly<Record<string, unknown>>,
  filePath?: string,
): Result<ValidatedFrontmatter, KoiError> {
  const prefix =
    filePath !== undefined
      ? `Skill frontmatter validation failed in ${filePath}`
      : "Skill frontmatter validation failed";
  // Cast needed: Zod's inferred transform output matches ValidatedFrontmatter shape
  return validateWith(frontmatterSchema as z.ZodType<ValidatedFrontmatter>, raw, prefix);
}
