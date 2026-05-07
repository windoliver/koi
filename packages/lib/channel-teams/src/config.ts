/**
 * @koi/channel-teams — runtime config + validation.
 */

import { z } from "zod";

export type ServiceUrlPattern = {
  readonly scheme: "https";
  readonly host: string;
  readonly hostMatch: "exact" | "subdomain";
};

export type CloudProfile = "public" | "gov" | { readonly issuer: string; readonly jwksUri: string };

export type TeamsConfig = {
  readonly appId: string;
  readonly appPassword: string;
  readonly tenantAllowlist: readonly string[];
  readonly cloud: CloudProfile;
  readonly serviceUrlAllowlist: readonly ServiceUrlPattern[];
  readonly production: boolean;
  readonly handlerTimeoutMs: number;
  readonly commitTtlMs: number;
};

export type TeamsConfigError = {
  readonly code: "INVALID_CONFIG";
  readonly message: string;
};

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: TeamsConfigError };

const ServiceUrlPatternSchema = z.object({
  scheme: z.literal("https"),
  host: z.string().min(1),
  hostMatch: z.union([z.literal("exact"), z.literal("subdomain")]),
});

const CloudInlineSchema = z.object({
  issuer: z.string().url(),
  jwksUri: z.string().url(),
});

const CloudSchema = z
  .union([z.literal("public"), z.literal("gov"), CloudInlineSchema])
  .default("public");

const TeamsConfigSchema = z.object({
  appId: z.string().min(1),
  appPassword: z.string().min(1),
  tenantAllowlist: z.array(z.string().min(1)).min(1),
  cloud: CloudSchema,
  serviceUrlAllowlist: z.array(ServiceUrlPatternSchema).min(1),
  production: z.boolean().default(false),
  handlerTimeoutMs: z.number().int().min(1).default(300_000),
  commitTtlMs: z
    .number()
    .int()
    .min(1)
    .default(24 * 60 * 60 * 1000),
});

export function validateTeamsConfig(input: unknown): Result<TeamsConfig> {
  const r = TeamsConfigSchema.safeParse(input);
  if (!r.success) {
    return { ok: false, error: { code: "INVALID_CONFIG", message: r.error.message } };
  }
  return { ok: true, value: r.data satisfies TeamsConfig };
}
