/**
 * Zod schemas for raw YAML manifest validation.
 *
 * Two-phase approach:
 * 1. `rawManifestSchema` validates the YAML structure (accepts shorthand formats)
 * 2. Transform layer (transform.ts) normalizes shorthand → L0 types
 */

import { z } from "zod";

// ── Raw manifest type (explicit for isolatedDeclarations) ──

/** A named config item in standard format. */
interface NamedConfig {
  readonly name: string;
  readonly options?: Readonly<Record<string, unknown>> | undefined;
}

/** Permissions block in the manifest. */
interface RawPermissions {
  readonly allow?: readonly string[] | undefined;
  readonly deny?: readonly string[] | undefined;
  readonly ask?: readonly string[] | undefined;
}

/** The raw parsed YAML structure before transformation. */
export interface RawManifest {
  readonly name: string;
  readonly version: string;
  readonly description?: string | undefined;
  readonly model: string | NamedConfig;
  readonly tools?:
    | readonly Record<string, unknown>[]
    | Readonly<Record<string, readonly Record<string, unknown>[]>>
    | undefined;
  readonly channels?: readonly Record<string, unknown>[] | undefined;
  readonly middleware?: readonly Record<string, unknown>[] | undefined;
  readonly permissions?: RawPermissions | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
  readonly engine?: unknown;
  readonly schedule?: unknown;
  readonly webhooks?: unknown;
  readonly forge?: unknown;
  readonly [key: string]: unknown;
}

// ── Shared base schemas ──

const jsonObjectSchema = z.record(z.string(), z.unknown());

/**
 * Named config item — used for tools, channels, middleware when specified as objects.
 * Accepts either `{ name: string, options?: object }` or a key-value map `{ "@koi/pkg": { ... } }`.
 */
const namedConfigSchema = z.union([
  z.object({
    name: z.string(),
    options: jsonObjectSchema.optional(),
  }),
  jsonObjectSchema,
]);

// ── Model schema ──

/** Model can be a string shorthand or a full config object. */
const modelSchema = z.union([
  z.string(),
  z.object({
    name: z.string(),
    options: jsonObjectSchema.optional(),
  }),
]);

// ── Tools schema ──

/** Tools can be an array of named configs or an object with keyed sections (e.g., `mcp`). */
const toolsSchema = z.union([
  z.array(namedConfigSchema),
  z.record(z.string(), z.array(namedConfigSchema)),
]);

// ── Permissions schema ──

const permissionsSchema = z.object({
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
  ask: z.array(z.string()).optional(),
});

// ── Raw manifest schema ──

/**
 * Schema for the raw parsed YAML. Accepts all shorthand formats.
 * Uses `.passthrough()` to preserve unknown fields for warning detection.
 */
export const rawManifestSchema: z.ZodType<RawManifest> = z
  .object({
    name: z.string(),
    version: z.string(),
    description: z.string().optional(),
    model: modelSchema,
    tools: toolsSchema.optional(),
    channels: z.array(namedConfigSchema).optional(),
    middleware: z.array(namedConfigSchema).optional(),
    permissions: permissionsSchema.optional(),
    metadata: jsonObjectSchema.optional(),
    // Extension fields (passthrough to LoadedManifest)
    engine: z.unknown().optional(),
    schedule: z.unknown().optional(),
    webhooks: z.unknown().optional(),
    forge: z.unknown().optional(),
  })
  .passthrough();

// ── Error conversion (delegated to @koi/validation) ──

export { zodToKoiError } from "@koi/validation";
