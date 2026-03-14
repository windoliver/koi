/**
 * Shared Zod schemas for credential requirements.
 *
 * Single source of truth — imported by @koi/validation brick-requires,
 * @koi/skills frontmatter, @koi/forge-tools input parsing, and @koi/manifest.
 */

import { z } from "zod";

/** Known credential kinds with autocomplete + extensible via passthrough. */
function createCredentialKindSchema(): z.ZodType<string> {
  return z.union([
    z.enum(["connection_string", "api_key", "oauth2", "bearer_token", "mcp_transport"]),
    z.string(),
  ]);
}

export const credentialKindSchema: z.ZodType<string> = createCredentialKindSchema();

/** A single credential requirement. */
function createCredentialRequirementSchema(): z.ZodType<{
  readonly kind: string;
  readonly ref: string;
  readonly scopes?: readonly string[] | undefined;
}> {
  return z.object({
    kind: credentialKindSchema,
    ref: z.string().min(1, "Credential ref must not be empty"),
    scopes: z.array(z.string()).optional(),
  });
}

export const credentialRequirementSchema: z.ZodType<{
  readonly kind: string;
  readonly ref: string;
  readonly scopes?: readonly string[] | undefined;
}> = createCredentialRequirementSchema();

/** A record of named credential requirements (key = logical name). */
function createCredentialRequiresSchema(): z.ZodType<
  Readonly<
    Record<
      string,
      {
        readonly kind: string;
        readonly ref: string;
        readonly scopes?: readonly string[] | undefined;
      }
    >
  >
> {
  return z.record(z.string(), credentialRequirementSchema);
}

export const credentialRequiresSchema: z.ZodType<
  Readonly<
    Record<
      string,
      {
        readonly kind: string;
        readonly ref: string;
        readonly scopes?: readonly string[] | undefined;
      }
    >
  >
> = createCredentialRequiresSchema();
