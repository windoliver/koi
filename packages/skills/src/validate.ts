/**
 * Agent Skills Standard frontmatter validation.
 *
 * Enforces: name (1-64 chars, lowercase + hyphens), description (1-1024 chars),
 * optional license, compatibility, metadata, allowed-tools.
 */

import type { KoiError, Result } from "@koi/core";
import { zodToKoiError } from "@koi/validation";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Validated output type
// ---------------------------------------------------------------------------

export interface ValidatedSkillFrontmatter {
  readonly name: string;
  readonly description: string;
  readonly license?: string;
  readonly compatibility?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly allowedTools?: readonly string[];
  readonly includes?: readonly string[];
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Agent Skills Standard name: 1-64 chars, lowercase letters, digits, hyphens.
 * No leading, trailing, or consecutive hyphens.
 */
const skillNameSchema = z
  .string()
  .min(1, "Skill name must be at least 1 character")
  .max(64, "Skill name must be at most 64 characters")
  .regex(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
    "Skill name must be lowercase alphanumeric with hyphens, no leading/trailing/consecutive hyphens",
  )
  .refine((s) => !s.includes("--"), "Skill name must not contain consecutive hyphens");

/**
 * Allowed include path pattern: relative paths only (./file.md, ../sibling/file.md).
 * Rejects absolute paths (/etc/passwd) and URL schemes (https://...).
 */
const INCLUDE_PATH_RE = /^\.{1,2}\/[a-zA-Z0-9._/-]+$/;

const skillFrontmatterSchema = z.object({
  name: skillNameSchema,
  description: z
    .string()
    .min(1, "Skill description must not be empty")
    .max(1024, "Skill description must be at most 1024 characters"),
  license: z.string().optional(),
  compatibility: z.string().max(500, "Compatibility must be at most 500 characters").optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  "allowed-tools": z.string().optional(),
  includes: z
    .array(
      z.string().regex(INCLUDE_PATH_RE, "Include path must be a relative path (./... or ../..)"),
    )
    .optional(),
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validates raw frontmatter against the Agent Skills Standard.
 *
 * Parses `allowed-tools` from space-delimited string to string array.
 * Unknown fields are silently ignored (passthrough).
 */
export function validateSkillFrontmatter(
  raw: Readonly<Record<string, unknown>>,
): Result<ValidatedSkillFrontmatter, KoiError> {
  const result = skillFrontmatterSchema.safeParse(raw);
  if (!result.success) {
    return { ok: false, error: zodToKoiError(result.error, "Skill frontmatter validation failed") };
  }

  const { name, description, license, compatibility, metadata, includes } = result.data;
  const allowedToolsRaw = result.data["allowed-tools"];

  // Parse allowed-tools: space-delimited string → array
  const allowedTools =
    allowedToolsRaw !== undefined
      ? allowedToolsRaw.split(/\s+/).filter((s) => s.length > 0)
      : undefined;

  const validated: ValidatedSkillFrontmatter = {
    name,
    description,
    ...(license !== undefined ? { license } : {}),
    ...(compatibility !== undefined ? { compatibility } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
    ...(allowedTools !== undefined ? { allowedTools } : {}),
    ...(includes !== undefined ? { includes } : {}),
  };

  return { ok: true, value: validated };
}
