import { validateWith } from "@koi/validation";
import { z } from "zod";
import type { InstallRequest, MarketplacePublishRequest } from "./types.js";

const marketplaceKindSchema = z.union([z.literal("skill"), z.literal("plugin")]);

const artifactSchema = z.object({
  url: z.string().url(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/i)
    .optional(),
  sizeBytes: z.number().int().positive().optional(),
});

const compatibilitySchema = z.object({
  koi: z.string().min(1).optional(),
});

const securityFindingSchema = z.object({
  severity: z.union([
    z.literal("CRITICAL"),
    z.literal("HIGH"),
    z.literal("MEDIUM"),
    z.literal("LOW"),
  ]),
  message: z.string().min(1),
});

const publishRequestSchema: z.ZodType<MarketplacePublishRequest> = z.object({
  kind: marketplaceKindSchema,
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/),
  description: z.string().min(1),
  publisher: z.string().min(1),
  category: z.string().min(1),
  tags: z.array(z.string().min(1)).readonly().optional(),
  featured: z.boolean().optional(),
  artifact: artifactSchema,
  compatibility: compatibilitySchema.optional(),
  skill: z.record(z.string(), z.unknown()).readonly().optional(),
  plugin: z.unknown().optional(),
  rating: z.number().min(0).max(5).optional(),
  publisherReputation: z.number().min(0).max(1).optional(),
  securityFindings: z.array(securityFindingSchema).readonly().optional(),
});

const installRequestSchema: z.ZodType<InstallRequest> = z.object({
  kind: marketplaceKindSchema,
  name: z.string().min(1),
  version: z.string().min(1).optional(),
  koiVersion: z.string().min(1).optional(),
});

const skillFrontmatterSchema = z.object({
  name: z.string().min(1, "name must not be empty"),
  description: z.string().min(1, "description must not be empty"),
  license: z.string().optional(),
  compatibility: z.string().optional(),
  allowedTools: z.array(z.string()).readonly().optional(),
  tags: z.array(z.string()).readonly().optional(),
  requires: z
    .object({
      bins: z.array(z.string()).readonly().optional(),
      env: z.array(z.string()).readonly().optional(),
      tools: z.array(z.string()).readonly().optional(),
      network: z.boolean().optional(),
      platform: z.array(z.string()).readonly().optional(),
      credentials: z
        .record(
          z.string(),
          z.object({
            kind: z.string().min(1),
            ref: z.string().min(1),
          }),
        )
        .optional(),
    })
    .optional(),
  metadata: z.record(z.string(), z.string()).readonly().optional(),
  executionMode: z.union([z.literal("inline"), z.literal("fork")]).optional(),
});

const pluginManifestSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/, "Plugin name must be kebab-case"),
  version: z.string().min(1, "Version is required"),
  description: z.string().min(1, "Description is required"),
  author: z.string().optional(),
  keywords: z.array(z.string()).readonly().optional(),
  skills: z.array(z.string()).readonly().optional(),
  hooks: z.string().optional(),
  mcpServers: z.string().optional(),
  middleware: z.array(z.string()).readonly().optional(),
});

export function validatePublishRequest(raw: unknown): MarketplacePublishRequest {
  const parsed = validateWith(publishRequestSchema, raw, "Marketplace publish validation failed");
  if (!parsed.ok) {
    throw new Error(parsed.error.message);
  }

  const request = parsed.value;
  if (request.kind === "skill") {
    if (request.skill === undefined) {
      throw new Error("Marketplace publish validation failed: skill metadata is required");
    }
    const skill = validateWith(
      skillFrontmatterSchema,
      request.skill,
      "Skill frontmatter validation failed",
    );
    if (!skill.ok) {
      throw new Error(skill.error.message);
    }
    return request;
  }

  if (request.plugin === undefined) {
    throw new Error("Marketplace publish validation failed: plugin manifest is required");
  }
  const plugin = validateWith(
    pluginManifestSchema,
    request.plugin,
    "Plugin manifest validation failed",
  );
  if (!plugin.ok) {
    throw new Error(plugin.error.message);
  }
  return request;
}

export function validateInstallRequest(raw: unknown): InstallRequest {
  const parsed = validateWith(installRequestSchema, raw, "Marketplace install validation failed");
  if (!parsed.ok) {
    throw new Error(parsed.error.message);
  }
  return parsed.value;
}
