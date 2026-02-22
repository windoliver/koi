/**
 * Validates raw context configuration from koi.yaml into typed ContextManifestConfig.
 */

import type { KoiError, Result } from "@koi/core";
import { validateWith } from "@koi/validation";
import { z } from "zod";
import type { ContextManifestConfig } from "./types.js";

const sourceBaseSchema = z.object({
  label: z.string().optional(),
  required: z.boolean().optional(),
  priority: z.number().optional(),
  maxTokens: z.number().positive().optional(),
});

const textSourceSchema = sourceBaseSchema.extend({
  kind: z.literal("text"),
  text: z.string(),
});

const fileSourceSchema = sourceBaseSchema.extend({
  kind: z.literal("file"),
  path: z.string(),
});

const memorySourceSchema = sourceBaseSchema.extend({
  kind: z.literal("memory"),
  query: z.string(),
});

const skillSourceSchema = sourceBaseSchema.extend({
  kind: z.literal("skill"),
  name: z.string(),
});

const toolSchemaSourceSchema = sourceBaseSchema.extend({
  kind: z.literal("tool_schema"),
  tools: z.array(z.string()).optional(),
});

const contextSourceSchema = z.discriminatedUnion("kind", [
  textSourceSchema,
  fileSourceSchema,
  memorySourceSchema,
  skillSourceSchema,
  toolSchemaSourceSchema,
]);

const contextManifestConfigSchema = z.object({
  sources: z.array(contextSourceSchema).min(1, "At least one context source is required"),
  maxTokens: z.number().positive().optional(),
});

/**
 * Validates raw context configuration from koi.yaml.
 *
 * @param raw - Unknown value from the manifest `context` field
 * @returns Validated config or a KoiError with details
 */
export function validateContextConfig(raw: unknown): Result<ContextManifestConfig, KoiError> {
  return validateWith(contextManifestConfigSchema, raw, "Context config validation failed");
}
