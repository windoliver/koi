/**
 * Tool auto-resolution — resolves manifest `package` fields into ComponentProviders.
 *
 * Scans manifest.tools for entries with a `package` field, imports each package
 * in parallel, extracts its ToolRegistration export, and builds ComponentProviders
 * via createProviderFromRegistration.
 *
 * Also validates that manifest-declared tools exist after assembly, warning on
 * missing tools with enhanced conflict provenance.
 */

import type {
  Agent,
  AgentManifest,
  ComponentProvider,
  JsonObject,
  ToolRegistration,
} from "@koi/core";
import { toolToken } from "@koi/core";
import type { AssemblyConflict } from "./agent-entity.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Function signature for importing a package and extracting its ToolRegistration. */
export type PackageResolver = (
  packageName: string,
) => Promise<{ readonly registration: ToolRegistration }>;

/** Function signature for the provider factory (injected to avoid circular deps). */
type ProviderFactory = (registration: ToolRegistration, options?: JsonObject) => ComponentProvider;

/** Default package resolver: dynamic import. */
const defaultResolvePackage: PackageResolver = async (packageName: string) => {
  const mod = (await import(packageName)) as { readonly registration?: ToolRegistration };
  if (mod.registration === undefined) {
    throw new Error(`Package "${packageName}" does not export a "registration" ToolRegistration`);
  }
  return { registration: mod.registration };
};

// ---------------------------------------------------------------------------
// resolveToolPackages
// ---------------------------------------------------------------------------

/**
 * Resolve manifest tool entries with `package` fields into ComponentProviders.
 *
 * Imports are performed in parallel. Failed imports log a warning and are skipped.
 * Duplicate package names are resolved once (deduped).
 */
export async function resolveToolPackages(
  manifest: AgentManifest,
  resolvePackage: PackageResolver | undefined,
  createProvider: ProviderFactory,
): Promise<readonly ComponentProvider[]> {
  const tools = manifest.tools ?? [];
  const packageEntries = tools.filter(
    (t): t is typeof t & { readonly package: string } => t.package !== undefined,
  );
  if (packageEntries.length === 0) return [];

  const resolver = resolvePackage ?? defaultResolvePackage;

  // Dedup by package name — multiple tools can come from the same package
  const uniquePackages = new Map<string, JsonObject | undefined>();
  for (const entry of packageEntries) {
    if (!uniquePackages.has(entry.package)) {
      uniquePackages.set(entry.package, entry.options);
    }
  }

  // Parallel import with graceful failure
  const results = await Promise.all(
    [...uniquePackages.entries()].map(async ([packageName, options]) => {
      try {
        const { registration } = await resolver(packageName);
        return { packageName, provider: createProvider(registration, options) };
      } catch (err: unknown) {
        console.warn(
          `[koi] Failed to resolve tool package "${packageName}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return { packageName, provider: undefined };
      }
    }),
  );

  return results
    .filter(
      (r): r is typeof r & { readonly provider: ComponentProvider } => r.provider !== undefined,
    )
    .map((r) => r.provider);
}

// ---------------------------------------------------------------------------
// validateManifestTools
// ---------------------------------------------------------------------------

/**
 * Warn when manifest-declared tools are not found after assembly.
 *
 * Checks each entry in manifest.tools against the assembled agent's components.
 * Tools with a `package` field that failed to resolve will trigger a warning.
 * Tools without a `package` field that are missing also trigger a warning
 * (they were expected to come from an explicit provider).
 *
 * Also enhances conflict warnings with package provenance when available.
 */
export function validateManifestTools(
  manifest: AgentManifest,
  agent: Agent,
  conflicts: readonly AssemblyConflict[],
): void {
  const tools = manifest.tools ?? [];

  // Warn on missing tools
  for (const toolConfig of tools) {
    const token = toolToken(toolConfig.name);
    if (!agent.has(token)) {
      const source =
        toolConfig.package !== undefined
          ? ` (package: "${toolConfig.package}")`
          : " (no package specified — expected from explicit provider)";
      console.warn(
        `[koi] Tool "${toolConfig.name}" declared in manifest but not found after assembly${source}`,
      );
    }
  }

  // Enhanced conflict warnings with provenance
  for (const conflict of conflicts) {
    if (conflict.key.startsWith("tool:")) {
      const toolName = conflict.key.slice(5);
      console.warn(
        `[koi] Tool "${toolName}" conflict: "${conflict.winner}" wins over ${conflict.shadowed.map((s) => `"${s}"`).join(", ")}`,
      );
    }
  }
}
