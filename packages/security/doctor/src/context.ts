/**
 * DoctorContext factory with lazy memoized accessors.
 */

import type { AgentManifest } from "@koi/core";
import type { DependencyEntry, DoctorContext } from "./types.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface CreateDoctorContextOptions {
  readonly dependencies?: readonly DependencyEntry[];
  readonly envKeys?: ReadonlySet<string>;
  readonly packageJson?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDoctorContext(
  manifest: AgentManifest,
  options?: CreateDoctorContextOptions,
): DoctorContext {
  // Memoization caches — `let` justified: lazy one-shot initialization
  let middlewareNamesCache: ReadonlySet<string> | undefined;
  let toolNamesCache: ReadonlySet<string> | undefined;
  let dependenciesCache: readonly DependencyEntry[] | undefined;
  let envKeysCache: ReadonlySet<string> | undefined;

  const ctx: DoctorContext = {
    manifest,
    permissions: manifest.permissions,
    delegation: manifest.delegation,
    ...(options?.packageJson !== undefined ? { packageJson: options.packageJson } : {}),

    middlewareNames(): ReadonlySet<string> {
      if (middlewareNamesCache === undefined) {
        middlewareNamesCache = new Set((manifest.middleware ?? []).map((m) => m.name));
      }
      return middlewareNamesCache;
    },

    toolNames(): ReadonlySet<string> {
      if (toolNamesCache === undefined) {
        toolNamesCache = new Set((manifest.tools ?? []).map((t) => t.name));
      }
      return toolNamesCache;
    },

    dependencies(): readonly DependencyEntry[] {
      if (dependenciesCache === undefined) {
        if (options?.dependencies !== undefined) {
          dependenciesCache = options.dependencies;
        } else if (options?.packageJson !== undefined) {
          dependenciesCache = extractDependencies(options.packageJson);
        } else {
          dependenciesCache = [];
        }
      }
      return dependenciesCache;
    },

    envKeys(): ReadonlySet<string> {
      if (envKeysCache === undefined) {
        envKeysCache = options?.envKeys ?? new Set(Object.keys(process.env));
      }
      return envKeysCache;
    },
  };

  return ctx;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return value !== null && value !== undefined && typeof value === "object";
}

function extractDependencies(
  packageJson: Readonly<Record<string, unknown>>,
): readonly DependencyEntry[] {
  const deps = packageJson.dependencies;
  const prodEntries: readonly DependencyEntry[] = isStringRecord(deps)
    ? Object.entries(deps).map(([name, version]) => ({
        name,
        version: String(version),
        isDev: false,
      }))
    : [];

  const devDeps = packageJson.devDependencies;
  const devEntries: readonly DependencyEntry[] = isStringRecord(devDeps)
    ? Object.entries(devDeps).map(([name, version]) => ({
        name,
        version: String(version),
        isDev: true,
      }))
    : [];

  return [...prodEntries, ...devEntries];
}
