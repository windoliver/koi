/**
 * Zod schemas for raw YAML manifest validation.
 *
 * Two-phase approach:
 * 1. `rawManifestSchema` validates the YAML structure (accepts shorthand formats)
 * 2. Transform layer (transform.ts) normalizes shorthand → L0 types
 */

import { credentialRequirementSchema } from "@koi/validation";
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
  readonly sandbox?: boolean | undefined;
  readonly scopePromotion?: RawScopePromotion | undefined;
}

/** Webhook config in the manifest (inbound). */
interface RawWebhook {
  readonly path: string;
  readonly events?: readonly string[] | undefined;
  readonly secret?: string | undefined;
}

/** Outbound webhook config in the manifest. */
interface RawOutboundWebhook {
  readonly url: string;
  readonly events: readonly string[];
  readonly secret: string;
  readonly description?: string | undefined;
  readonly enabled?: boolean | undefined;
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

/** Soul/user config: path string or object with path + maxTokens. */
interface RawSoulUserConfig {
  readonly path: string;
  readonly maxTokens?: number | undefined;
}

/** Filesystem skill source in raw manifest. */
interface RawFilesystemSkillSource {
  readonly kind: "filesystem";
  readonly path: string;
}

/** Forged skill source in raw manifest. */
interface RawForgedSkillSource {
  readonly kind: "forged";
  readonly brickId: string;
}

/** Discriminated skill source in raw manifest. */
type RawSkillSource = RawFilesystemSkillSource | RawForgedSkillSource;

/** Skill config item in the manifest. */
interface RawSkillConfig {
  readonly name: string;
  readonly source: RawSkillSource;
  readonly options?: Readonly<Record<string, unknown>> | undefined;
}

/** Per-capability degeneracy config in raw manifest. */
interface RawDegeneracyConfig {
  readonly selectionStrategy: "fitness" | "round-robin" | "context-match" | "random";
  readonly minVariants: number;
  readonly maxVariants: number;
  readonly failoverEnabled: boolean;
}

/** Delegation config as output by Zod after defaults are applied. */
interface RawDelegation {
  readonly enabled: boolean;
  readonly maxChainDepth: number;
  readonly defaultTtlMs: number;
  readonly required?: boolean | undefined;
  readonly namespaceMode?: "copy" | "clean" | "shared" | undefined;
}

/** Sandbox execution environment config in the manifest. */
interface RawSandbox {
  readonly provider: string;
  readonly [key: string]: unknown;
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
  readonly skills?: readonly RawSkillConfig[] | undefined;
  readonly permissions?: RawPermissions | undefined;
  readonly delegation?: RawDelegation | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
  readonly engine?: string | NamedConfig | undefined;
  readonly schedule?: string | undefined;
  readonly webhooks?: readonly RawWebhook[] | undefined;
  readonly outboundWebhooks?: readonly RawOutboundWebhook[] | undefined;
  readonly forge?: RawForge | undefined;
  readonly context?: unknown;
  readonly soul?: string | RawSoulUserConfig | undefined;
  readonly user?: string | RawSoulUserConfig | undefined;
  readonly deploy?: RawDeploy | undefined;
  readonly scope?: RawScope | undefined;
  readonly degeneracy?: Readonly<Record<string, RawDegeneracyConfig>> | undefined;
  readonly delivery?:
    | { readonly kind: "streaming" }
    | {
        readonly kind: "deferred";
        readonly inboxMode?: "collect" | "followup" | "steer" | undefined;
      }
    | { readonly kind: "on_demand" }
    | undefined;
  readonly nexus?: { readonly url?: string | undefined } | undefined;
  readonly sandbox?: RawSandbox | undefined;
  readonly dataSources?:
    | readonly {
        readonly name: string;
        readonly protocol: string;
        readonly description?: string | undefined;
        readonly auth?:
          | {
              readonly kind: string;
              readonly ref: string;
              readonly scopes?: readonly string[] | undefined;
            }
          | undefined;
        readonly allowedHosts?: readonly string[] | undefined;
      }[]
    | undefined;
  readonly [key: string]: unknown;
}

// ── Template-syntax guard ──

/**
 * Pattern that matches Jinja-style (`{{...}}`) and Django-style (`{%...%}`) template expressions.
 * Single-brace format strings like `{region}` are intentionally allowed.
 */
const TEMPLATE_EXPR_RE = /\{\{|\{%/;

/**
 * Wraps a Zod string schema to reject template expressions ({{...}} or {%...%}).
 * Use on manifest fields that must be static values — no runtime interpolation.
 */
function noTemplateExpressions(schema: z.ZodString) {
  return schema.refine(
    (val) => !TEMPLATE_EXPR_RE.test(val),
    "Manifest does not support template expressions ({{...}} or {%...%}). Use static values only.",
  );
}

// ── Shared base schemas ──

const jsonObjectSchema = z.record(z.string(), z.unknown());

/**
 * Named config item — used for tools, channels, middleware when specified as objects.
 * Accepts either `{ name: string, options?: object }` or a key-value map `{ "@koi/pkg": { ... } }`.
 */
const namedConfigSchema = z.union([
  z.object({
    name: noTemplateExpressions(z.string()),
    options: jsonObjectSchema.optional(),
    version: z.string().optional(),
    publisher: z.string().optional(),
  }),
  jsonObjectSchema,
]);

// ── Skill config schema ──

const filesystemSkillSourceSchema = z.object({
  kind: z.literal("filesystem"),
  path: z.string(),
});

const forgedSkillSourceSchema = z.object({
  kind: z.literal("forged"),
  brickId: z.string(),
});

const skillSourceSchema = z.discriminatedUnion("kind", [
  filesystemSkillSourceSchema,
  forgedSkillSourceSchema,
]);

/** Skill config item: name + source + optional options. */
const skillConfigSchema = z.object({
  name: noTemplateExpressions(z.string()),
  source: skillSourceSchema,
  options: jsonObjectSchema.optional(),
});

// ── Channel identity schema ──

/** Per-channel persona config embedded in the channel config block. */
const channelIdentitySchema = z
  .object({
    name: z.string().optional(),
    avatar: z.string().optional(),
    instructions: z.string().optional(),
  })
  .optional();

/**
 * Middleware config item — same as namedConfigSchema but also supports `required` flag.
 * Accepts either `{ name: string, options?: object, required?: boolean }` or a
 * key-value map `{ "@koi/pkg": { ... } }` (required not supported in shorthand form).
 */
const middlewareConfigSchema = z.union([
  z.object({
    name: noTemplateExpressions(z.string()),
    options: jsonObjectSchema.optional(),
    version: z.string().optional(),
    publisher: z.string().optional(),
    required: z.boolean().optional(),
  }),
  jsonObjectSchema,
]);

/**
 * Channel config item — same as namedConfigSchema but also supports `identity` block.
 * Accepts either `{ name: string, options?: object, identity?: ChannelIdentity }` or a
 * key-value map `{ "@koi/pkg": { ... } }` (identity not supported in shorthand form).
 */
const rawChannelSchema = z.union([
  z.object({
    name: noTemplateExpressions(z.string()),
    options: jsonObjectSchema.optional(),
    identity: channelIdentitySchema,
    version: z.string().optional(),
    publisher: z.string().optional(),
  }),
  jsonObjectSchema,
]);

// ── Model schema ──

/** Model can be a string shorthand or a full config object. */
const modelSchema = z.union([
  noTemplateExpressions(z.string()),
  z.object({
    name: noTemplateExpressions(z.string()),
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

/** Valid outbound webhook event kinds. */
const webhookEventKindSchema = z.enum([
  "session.started",
  "session.ended",
  "tool.failed",
  "tool.succeeded",
  "budget.warning",
  "budget.exhausted",
  "security.violation",
]);

/** Single outbound webhook config. */
const outboundWebhookSchema = z.object({
  url: z.string().url(),
  events: z.array(webhookEventKindSchema).min(1),
  secret: z.string().min(1),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
});

/** Array of outbound webhook configs. */
const outboundWebhooksSchema = z.array(outboundWebhookSchema);

/** Tool policy schema (sandbox boolean + capabilities). */
const toolPolicySchema = z.object({
  sandbox: z.boolean().default(true),
  capabilities: z.record(z.string(), z.unknown()).default({}),
});

/** Forge governance config. */
const forgeSchema = z.object({
  enabled: z.boolean().default(true),
  maxForgeDepth: z.number().int().nonnegative().default(1),
  maxForgesPerSession: z.number().int().positive().default(5),
  defaultScope: z.enum(["agent", "zone", "global"]).default("agent"),
  defaultPolicy: toolPolicySchema.default({ sandbox: true, capabilities: {} }),
  scopePromotion: z
    .object({
      requireHumanApproval: z.boolean().default(true),
    })
    .optional(),
});

/** Soul/user config: string path/inline or object with path + maxTokens. */
const soulUserSchema = z.union([
  z.string(),
  z.object({
    path: z.string(),
    maxTokens: z.number().positive().optional(),
  }),
]);

/** Deploy configuration for background service management. */
const deploySchema = z.object({
  port: z.number().int().min(1).max(65535).default(9100),
  restart: z.enum(["on-failure", "always", "no"]).default("on-failure"),
  restartDelaySec: z.number().nonnegative().default(5),
  envFile: z.string().optional(),
  logDir: z.string().optional(),
  system: z.boolean().default(false),
});

// ── Degeneracy schema ──

/** Per-capability degeneracy config: selection strategy + variant bounds. */
const degeneracyConfigSchema = z
  .object({
    selectionStrategy: z
      .enum(["fitness", "round-robin", "context-match", "random"])
      .default("fitness"),
    minVariants: z.number().int().min(1).default(1),
    maxVariants: z.number().int().min(1).default(3),
    failoverEnabled: z.boolean().default(true),
  })
  .refine((d) => d.minVariants <= d.maxVariants, {
    message: "minVariants must be <= maxVariants",
  });

/** Record of capability name → degeneracy config. */
const degeneracySchema = z.record(z.string(), degeneracyConfigSchema);

// ── Delivery policy schema ──

/** Delivery policy for spawned child agents. */
const deliveryPolicySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("streaming") }),
  z.object({
    kind: z.literal("deferred"),
    inboxMode: z.enum(["collect", "followup", "steer"]).optional(),
  }),
  z.object({ kind: z.literal("on_demand") }),
]);

// ── Delegation schema ──

/** Delegation subsystem configuration. */
const delegationSchema = z.object({
  enabled: z.boolean(),
  maxChainDepth: z.number().int().min(0).default(3),
  defaultTtlMs: z.number().int().positive().default(3_600_000),
  required: z.boolean().optional(),
  namespaceMode: z.enum(["copy", "clean", "shared"]).optional(),
});

// ── Nexus schema ──

/** Nexus backend connection config in the manifest. */
const nexusSchema = z.object({
  url: z.string().optional(),
});

// ── Scope schema ──

/** Declarative scope boundaries for agent subsystems. */
const scopeSchema = z.object({
  filesystem: z
    .object({
      root: z.string(),
      mode: z.enum(["rw", "ro"]).default("rw"),
    })
    .optional(),
  browser: z
    .object({
      allowedProtocols: z.array(z.string()).optional(),
      allowedDomains: z.array(z.string()).optional(),
      blockPrivateAddresses: z.boolean().optional(),
      sandbox: z.boolean().optional(),
    })
    .optional(),
  credentials: z
    .object({
      keyPattern: z.string(),
    })
    .optional(),
  memory: z
    .object({
      namespace: z.string(),
    })
    .optional(),
});

/** Scope section as output by Zod after defaults are applied. */
interface RawScope {
  readonly filesystem?: { readonly root: string; readonly mode: "rw" | "ro" } | undefined;
  readonly browser?:
    | {
        readonly allowedProtocols?: readonly string[] | undefined;
        readonly allowedDomains?: readonly string[] | undefined;
        readonly blockPrivateAddresses?: boolean | undefined;
        readonly sandbox?: boolean | undefined;
      }
    | undefined;
  readonly credentials?: { readonly keyPattern: string } | undefined;
  readonly memory?: { readonly namespace: string } | undefined;
}

// ── Data source schema ──

/** Auth credential for a data source entry — reuses shared credential schema. */
const dataSourceAuthSchema = credentialRequirementSchema;

/** A single data source entry in koi.yaml `dataSources`. */
const dataSourceEntrySchema = z.object({
  name: z.string().min(1),
  protocol: z.string().min(1),
  description: z.string().optional(),
  auth: dataSourceAuthSchema.optional(),
  allowedHosts: z.array(z.string()).optional(),
});

/** Optional array of data source entries. */
const dataSourcesSchema = z.array(dataSourceEntrySchema).optional();

// ── Sandbox schema ──

/**
 * Sandbox execution environment config.
 *
 * Shape-only validation: requires `provider` string, passes through
 * provider-specific fields. Full provider validation happens at runtime
 * in `createCloudSandbox()` (L3).
 */
const sandboxSchema = z
  .object({
    provider: z.string().min(1),
  })
  .passthrough();

// ── Raw manifest schema ──

/**
 * Schema for the raw parsed YAML. Accepts all shorthand formats.
 * Uses `.passthrough()` to preserve unknown fields for warning detection.
 */
export const rawManifestSchema: z.ZodType<RawManifest> = z
  .object({
    name: noTemplateExpressions(z.string()),
    version: z.string(),
    description: z.string().optional(),
    model: modelSchema,
    tools: toolsSchema.optional(),
    channels: z.array(rawChannelSchema).optional(),
    middleware: z.array(middlewareConfigSchema).optional(),
    skills: z.array(skillConfigSchema).optional(),
    permissions: permissionsSchema.optional(),
    delegation: delegationSchema.optional(),
    metadata: jsonObjectSchema.optional(),
    // Extension fields — typed schemas instead of z.unknown()
    engine: engineSchema.optional(),
    schedule: scheduleSchema.optional(),
    webhooks: webhooksSchema.optional(),
    outboundWebhooks: outboundWebhooksSchema.optional(),
    forge: forgeSchema.optional(),
    context: z.unknown().optional(),
    soul: soulUserSchema.optional(),
    user: soulUserSchema.optional(),
    deploy: deploySchema.optional(),
    scope: scopeSchema.optional(),
    degeneracy: degeneracySchema.optional(),
    delivery: deliveryPolicySchema.optional(),
    nexus: nexusSchema.optional(),
    sandbox: sandboxSchema.optional(),
    dataSources: dataSourcesSchema,
  })
  .passthrough();

// ── Error conversion (delegated to @koi/validation) ──

export { zodToKoiError } from "@koi/validation";
