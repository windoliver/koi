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

/** Scope promotion config in forge section. */
interface RawScopePromotion {
  readonly requireHumanApproval?: boolean | undefined;
  readonly minTrustForZone?: "sandbox" | "verified" | "promoted" | undefined;
  readonly minTrustForGlobal?: "sandbox" | "verified" | "promoted" | undefined;
}

/** Forge governance config in the manifest. */
interface RawForge {
  readonly enabled?: boolean | undefined;
  readonly maxForgeDepth?: number | undefined;
  readonly maxForgesPerSession?: number | undefined;
  readonly defaultScope?: "agent" | "zone" | "global" | undefined;
  readonly trustTier?: "sandbox" | "verified" | "promoted" | undefined;
  readonly scopePromotion?: RawScopePromotion | undefined;
}

/** Webhook config in the manifest. */
interface RawWebhook {
  readonly path: string;
  readonly events?: readonly string[] | undefined;
  readonly secret?: string | undefined;
}

/** Deploy config in the manifest. */
interface RawDeploy {
  readonly port?: number | undefined;
  readonly restart?: "on-failure" | "always" | "no" | undefined;
  readonly restartDelaySec?: number | undefined;
  readonly envFile?: string | undefined;
  readonly logDir?: string | undefined;
  readonly system?: boolean | undefined;
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
  readonly engine?: string | NamedConfig | undefined;
  readonly schedule?: string | undefined;
  readonly webhooks?: readonly RawWebhook[] | undefined;
  readonly forge?: RawForge | undefined;
  readonly context?: unknown;
  readonly deploy?: RawDeploy | undefined;
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

// ── Extension field schemas (Decision #6: validate all) ──

/** Engine: string shorthand or object config. */
const engineSchema = z.union([
  z.string(),
  z.object({
    name: z.string(),
    options: jsonObjectSchema.optional(),
  }),
]);

/** Schedule: cron expression string. */
const scheduleSchema = z.string();

/** Single webhook config. */
const webhookSchema = z.object({
  path: z.string().startsWith("/"),
  events: z.array(z.string()).optional(),
  secret: z.string().optional(),
});

/** Array of webhook configs. */
const webhooksSchema = z.array(webhookSchema);

/** Trust tier values used in forge config. */
const trustTierSchema = z.enum(["sandbox", "verified", "promoted"]);

/** Forge governance config. */
const forgeSchema = z.object({
  enabled: z.boolean().default(true),
  maxForgeDepth: z.number().int().nonnegative().default(1),
  maxForgesPerSession: z.number().int().positive().default(5),
  defaultScope: z.enum(["agent", "zone", "global"]).default("agent"),
  trustTier: trustTierSchema.default("sandbox"),
  scopePromotion: z
    .object({
      requireHumanApproval: z.boolean().default(true),
      minTrustForZone: trustTierSchema.default("verified"),
      minTrustForGlobal: trustTierSchema.default("promoted"),
    })
    .optional(),
});

/** Deploy configuration for background service management. */
const deploySchema = z.object({
  port: z.number().int().min(1).max(65535).default(9100),
  restart: z.enum(["on-failure", "always", "no"]).default("on-failure"),
  restartDelaySec: z.number().nonnegative().default(5),
  envFile: z.string().optional(),
  logDir: z.string().optional(),
  system: z.boolean().default(false),
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
    // Extension fields — typed schemas instead of z.unknown()
    engine: engineSchema.optional(),
    schedule: scheduleSchema.optional(),
    webhooks: webhooksSchema.optional(),
    forge: forgeSchema.optional(),
    context: z.unknown().optional(),
    deploy: deploySchema.optional(),
  })
  .passthrough();

// ── Error conversion (delegated to @koi/validation) ──

export { zodToKoiError } from "@koi/validation";
