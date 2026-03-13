/**
 * Data source descriptors — ECS component types for auto-discovered data sources.
 *
 * NOT a new BrickKind. Data sources are a thin L0 type + manifest extension
 * that drives skill generation via the existing forge pipeline.
 */

import type { CredentialRequirement } from "./brick-store.js";

// ---------------------------------------------------------------------------
// Protocol discriminator
// ---------------------------------------------------------------------------

/** Known data source protocols + extensible via `(string & {})`. */
export type DataSourceProtocol =
  | "postgres"
  | "mysql"
  | "sqlite"
  | "http"
  | "graphql"
  | "mcp"
  | (string & {});

// ---------------------------------------------------------------------------
// Descriptor
// ---------------------------------------------------------------------------

/** Describes a discovered data source — attached to agents via ECS. */
export interface DataSourceDescriptor {
  readonly name: string;
  readonly protocol: DataSourceProtocol;
  readonly description?: string | undefined;
  readonly auth?: CredentialRequirement | undefined;
  readonly schemaProbed?: boolean | undefined;
  readonly allowedHosts?: readonly string[] | undefined;
}
