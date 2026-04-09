/**
 * Zod schema for plugin.json manifest validation.
 */

import type { KoiError, Result } from "@koi/core";
import { validateWith } from "@koi/validation";
import { z } from "zod";
import type { PluginManifest } from "./types.js";

// ---------------------------------------------------------------------------
// Name pattern: kebab-case, starts with lowercase letter
// ---------------------------------------------------------------------------

const KEBAB_CASE = /^[a-z][a-z0-9-]*$/;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const pluginManifestSchema = z.object({
  name: z
    .string()
    .regex(KEBAB_CASE, "Plugin name must be kebab-case (lowercase letters, digits, hyphens)"),
  version: z.string().min(1, "Version is required"),
  description: z.string().min(1, "Description is required"),
  author: z.string().optional(),
  keywords: z.array(z.string()).readonly().optional(),
  skills: z.array(z.string()).readonly().optional(),
  hooks: z.string().optional(),
  mcpServers: z.string().optional(),
  middleware: z.array(z.string()).readonly().optional(),
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validates a raw object against the plugin.json manifest schema.
 */
export function validatePluginManifest(raw: unknown): Result<PluginManifest, KoiError> {
  return validateWith(pluginManifestSchema, raw, "Plugin manifest validation failed");
}
