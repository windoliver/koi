/**
 * Zod schemas for the official MCP registry HTTP API
 * (registry.modelcontextprotocol.io v0.1, Nov 2025 spec).
 *
 * Only the subset of fields actually rendered or consumed by the
 * installer is parsed strictly. Unknown fields are stripped (Zod
 * default), keeping us forward-compatible with future schema versions.
 */

import { z } from "zod";

const transportRefSchema = z.object({ type: z.string() });

const registryPackageSchema = z.object({
  registryType: z.string(),
  identifier: z.string(),
  version: z.string().optional(),
  transport: transportRefSchema.optional(),
  runtimeArguments: z.array(z.unknown()).optional(),
  packageArguments: z.array(z.unknown()).optional(),
  environmentVariables: z.array(z.unknown()).optional(),
});

const registryRemoteSchema = z.object({
  url: z.string(),
  transport: transportRefSchema.optional(),
  headers: z.array(z.unknown()).optional(),
});

const repositorySchema = z.object({
  url: z.string().optional(),
  source: z.string().optional(),
});

export const registryServerSchema: z.ZodType<RegistryServer> = z.object({
  name: z.string().min(1),
  description: z.string(),
  version: z.string().min(1),
  title: z.string().optional(),
  websiteUrl: z.string().optional(),
  repository: repositorySchema.optional(),
  packages: z.array(registryPackageSchema).optional(),
  remotes: z.array(registryRemoteSchema).optional(),
  status: z.string().optional(),
  _meta: z.record(z.string(), z.unknown()).optional(),
});

export const registrySearchResponseSchema: z.ZodType<RegistrySearchResponse> = z.object({
  servers: z.array(registryServerSchema),
  metadata: z
    .object({
      count: z.number().optional(),
      nextCursor: z.string().optional(),
    })
    .optional(),
});

// Keep type definitions explicit (isolatedDeclarations).

export interface RegistryTransportRef {
  readonly type: string;
}

export interface RegistryPackage {
  readonly registryType: string;
  readonly identifier: string;
  readonly version?: string | undefined;
  readonly transport?: RegistryTransportRef | undefined;
  readonly runtimeArguments?: readonly unknown[] | undefined;
  readonly packageArguments?: readonly unknown[] | undefined;
  readonly environmentVariables?: readonly unknown[] | undefined;
}

export interface RegistryRemote {
  readonly url: string;
  readonly transport?: RegistryTransportRef | undefined;
  readonly headers?: readonly unknown[] | undefined;
}

export interface RegistryRepository {
  readonly url?: string | undefined;
  readonly source?: string | undefined;
}

export interface RegistryServer {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly title?: string | undefined;
  readonly websiteUrl?: string | undefined;
  readonly repository?: RegistryRepository | undefined;
  readonly packages?: readonly RegistryPackage[] | undefined;
  readonly remotes?: readonly RegistryRemote[] | undefined;
  readonly status?: string | undefined;
  readonly _meta?: Readonly<Record<string, unknown>> | undefined;
}

export interface RegistrySearchResponse {
  readonly servers: readonly RegistryServer[];
  readonly metadata?:
    | {
        readonly count?: number | undefined;
        readonly nextCursor?: string | undefined;
      }
    | undefined;
}
