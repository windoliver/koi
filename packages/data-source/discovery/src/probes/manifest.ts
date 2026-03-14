/**
 * Manifest probe — reads dataSources from agent manifest extensions.
 */

import type { DataSourceProbeResult } from "../types.js";

/** Shape of a data source entry in the agent manifest. */
export interface ManifestDataSourceEntry {
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
}

/** Probe manifest entries and return discovery results. */
export function probeManifest(
  entries: readonly ManifestDataSourceEntry[] | undefined,
): readonly DataSourceProbeResult[] {
  if (entries === undefined || entries.length === 0) return [];

  return entries.map(
    (entry): DataSourceProbeResult => ({
      source: "manifest",
      descriptor: {
        name: entry.name,
        protocol: entry.protocol,
        ...(entry.description !== undefined ? { description: entry.description } : {}),
        ...(entry.auth !== undefined ? { auth: entry.auth } : {}),
        ...(entry.allowedHosts !== undefined ? { allowedHosts: entry.allowedHosts } : {}),
      },
    }),
  );
}
