/**
 * Zod schemas for hook config validation.
 *
 * Validates hook definitions from agent manifests against the Phase 1
 * hook type boundary (command + http). Unknown hook kinds fail clearly.
 */

import type {
  CommandHookConfig,
  HookConfig,
  HookEventKind,
  HookFilter,
  HttpHookConfig,
} from "@koi/core";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Hook event kind schema — forward-compatible
// ---------------------------------------------------------------------------

/**
 * Accepts any non-empty string at runtime for forward compatibility (newer
 * event kinds must not brick older validators), while typing the output as
 * `HookEventKind` so the Zod schema satisfies the L0 `HookFilter` contract.
 */
const hookEventKindSchema: z.ZodType<HookEventKind> = z.custom<HookEventKind>(
  (val) => typeof val === "string" && val.length > 0,
  { message: "Event kind must be a non-empty string" },
);

// ---------------------------------------------------------------------------
// Hook filter schema
// ---------------------------------------------------------------------------

function createHookFilterSchema(): z.ZodType<HookFilter> {
  return z.object({
    events: z
      .array(hookEventKindSchema)
      .min(1, "events filter must not be empty — omit the field instead")
      .optional(),
    tools: z
      .array(z.string().min(1))
      .min(1, "tools filter must not be empty — omit the field instead")
      .optional(),
    channels: z
      .array(z.string().min(1))
      .min(1, "channels filter must not be empty — omit the field instead")
      .optional(),
  });
}

export const hookFilterSchema: z.ZodType<HookFilter> = createHookFilterSchema();

// ---------------------------------------------------------------------------
// Shared fields (not exported — used for composition only)
// ---------------------------------------------------------------------------

const hookBaseFields = {
  name: z.string().min(1, "Hook name must not be empty"),
  filter: hookFilterSchema.optional(),
  enabled: z.boolean().optional(),
  timeoutMs: z.number().int().positive("timeoutMs must be positive").optional(),
  serial: z.boolean().optional(),
} as const;

// ---------------------------------------------------------------------------
// Command hook schema
// ---------------------------------------------------------------------------

function createCommandHookSchema(): z.ZodType<CommandHookConfig> {
  return z.object({
    kind: z.literal("command"),
    ...hookBaseFields,
    cmd: z.array(z.string().min(1)).min(1, "cmd must have at least one element"),
    env: z.record(z.string(), z.string()).optional(),
  });
}

export const commandHookSchema: z.ZodType<CommandHookConfig> = createCommandHookSchema();

// ---------------------------------------------------------------------------
// HTTP hook schema
// ---------------------------------------------------------------------------

function createHttpHookSchema(): z.ZodType<HttpHookConfig> {
  return z.object({
    kind: z.literal("http"),
    ...hookBaseFields,
    url: z
      .string()
      .url("url must be a valid URL")
      .refine((val) => {
        try {
          const parsed = new URL(val);
          if (parsed.protocol === "https:") return true;
          if (parsed.protocol === "http:") {
            // HTTP loopback only allowed in development mode
            const isDev =
              process.env.NODE_ENV === "development" ||
              process.env.NODE_ENV === "test" ||
              process.env.KOI_DEV === "1";
            if (!isDev) return false;
            const host = parsed.hostname;
            return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
          }
          return false;
        } catch {
          return false;
        }
      }, "url must be HTTPS (HTTP loopback requires NODE_ENV=development or KOI_DEV=1)"),
    method: z.enum(["POST", "PUT"]).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    secret: z.string().optional(),
  });
}

export const httpHookSchema: z.ZodType<HttpHookConfig> = createHttpHookSchema();

// ---------------------------------------------------------------------------
// Discriminated union schema
// ---------------------------------------------------------------------------

function createHookConfigSchema(): z.ZodType<HookConfig> {
  // Use z.union since z.discriminatedUnion has ZodType<> annotation issues
  // with exactOptionalPropertyTypes. Runtime discrimination still works via
  // each variant's `kind: z.literal(...)` check.
  return z.union([commandHookSchema, httpHookSchema]);
}

export const hookConfigSchema: z.ZodType<HookConfig> = createHookConfigSchema();

// ---------------------------------------------------------------------------
// Array schema for manifest-level validation
// ---------------------------------------------------------------------------

function createHookConfigArraySchema(): z.ZodType<readonly HookConfig[]> {
  return z.array(hookConfigSchema);
}

export const hookConfigArraySchema: z.ZodType<readonly HookConfig[]> =
  createHookConfigArraySchema();
