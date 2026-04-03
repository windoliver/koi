/**
 * Zod schemas for hook config validation.
 *
 * Validates hook definitions from agent manifests against the Phase 1
 * hook type boundary (command + http). Unknown hook kinds fail clearly.
 */

import type {
  AgentHookConfig,
  CommandHookConfig,
  HookConfig,
  HookFilter,
  HttpHookConfig,
  PromptHookConfig,
} from "@koi/core";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Hook filter schema
// ---------------------------------------------------------------------------

function createHookFilterSchema(): z.ZodType<HookFilter> {
  return z.object({
    events: z
      .array(z.string().min(1))
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
  failClosed: z.boolean().optional(),
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
    allowedEnvVars: z.array(z.string().min(1)).min(1).optional(),
  });
}

export const httpHookSchema: z.ZodType<HttpHookConfig> = createHttpHookSchema();

// ---------------------------------------------------------------------------
// Agent hook schema
// ---------------------------------------------------------------------------

const hookRedactionConfigSchema = z.object({
  enabled: z.boolean().optional(),
  censor: z.enum(["redact", "mask", "remove"]).optional(),
  sensitiveFields: z
    .array(z.string().min(1))
    .min(1, "sensitiveFields must not be empty — omit the field instead")
    .optional(),
});

function createAgentHookSchema(): z.ZodType<AgentHookConfig> {
  return z.object({
    kind: z.literal("agent"),
    ...hookBaseFields,
    prompt: z.string().min(1, "Agent hook prompt must not be empty"),
    model: z.string().optional(),
    systemPrompt: z.string().optional(),
    maxTurns: z.number().int().positive("maxTurns must be positive").optional(),
    maxTokens: z.number().int().positive("maxTokens must be positive").optional(),
    maxSessionTokens: z.number().int().positive("maxSessionTokens must be positive").optional(),
    toolDenylist: z
      .array(z.string().min(1))
      .min(1, "toolDenylist must not be empty — omit the field instead")
      .optional(),
    forwardRawPayload: z.boolean().optional(),
    redaction: hookRedactionConfigSchema.optional(),
  });
}

export const agentHookSchema: z.ZodType<AgentHookConfig> = createAgentHookSchema();

// ---------------------------------------------------------------------------
// Prompt hook schema
// ---------------------------------------------------------------------------

function createPromptHookSchema(): z.ZodType<PromptHookConfig> {
  return z.object({
    kind: z.literal("prompt"),
    ...hookBaseFields,
    prompt: z.string().min(1, "Prompt hook prompt must not be empty"),
    model: z.string().optional(),
    maxTokens: z.number().int().positive("maxTokens must be positive").optional(),
  });
}

export const promptHookSchema: z.ZodType<PromptHookConfig> = createPromptHookSchema();

// ---------------------------------------------------------------------------
// Discriminated union schema
// ---------------------------------------------------------------------------

function createHookConfigSchema(): z.ZodType<HookConfig> {
  // Use z.union since z.discriminatedUnion has ZodType<> annotation issues
  // with exactOptionalPropertyTypes. Runtime discrimination still works via
  // each variant's `kind: z.literal(...)` check.
  return z.union([commandHookSchema, httpHookSchema, promptHookSchema, agentHookSchema]);
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
