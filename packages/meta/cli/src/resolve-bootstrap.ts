/**
 * CLI glue: resolves bootstrap sources from .koi/ hierarchy
 * and maps them to context TextSource[] for the hydrator pipeline.
 *
 * This bridges @koi/bootstrap (L2) and @koi/context (L2) inside
 * the CLI (L3), avoiding any L2-to-L2 dependency.
 */

import { dirname, resolve } from "node:path";
import { resolveBootstrap } from "@koi/bootstrap";
import type { BootstrapManifestConfig, TextSource } from "@koi/context";

/**
 * Resolves bootstrap sources from the .koi/ hierarchy.
 *
 * @param config - Bootstrap config from manifest (true = defaults, object = custom)
 * @param manifestPath - Path to the manifest file (rootDir resolved relative to this)
 * @param agentName - Agent name from manifest.name (used when config doesn't override)
 * @returns Resolved TextSource[] for merging into context config, empty on failure
 */
export async function resolveBootstrapSources(
  config: true | BootstrapManifestConfig,
  manifestPath: string,
  agentName: string,
): Promise<readonly TextSource[]> {
  const manifestDir = dirname(resolve(manifestPath));

  // Parse config: true → all defaults, object → merge with defaults
  const rootDir =
    config === true || config.rootDir === undefined
      ? manifestDir
      : resolve(manifestDir, config.rootDir);

  // agentName: undefined → use manifest name, null → disable, string → use override
  const resolvedAgentName =
    config === true
      ? agentName
      : config.agentName === null
        ? undefined
        : (config.agentName ?? agentName);

  // Map custom slots if provided
  const slots =
    config !== true && config.slots !== undefined
      ? config.slots.map((s) => ({
          fileName: s.fileName,
          label: s.label ?? s.fileName,
          budget: s.budget ?? 8_000,
        }))
      : undefined;

  const result = await resolveBootstrap({
    rootDir,
    agentName: resolvedAgentName,
    slots,
  });

  if (!result.ok) {
    process.stderr.write(`warn: Bootstrap resolution failed: ${result.error.message}\n`);
    return [];
  }

  // Forward warnings
  for (const warning of result.value.warnings) {
    process.stderr.write(`warn: [bootstrap] ${warning}\n`);
  }

  // Map BootstrapTextSource[] → TextSource[] via spread (structurally compatible)
  return result.value.sources.map((s) => ({
    ...s,
  }));
}

/** Type guard: checks if raw manifest context has a bootstrap field. */
function hasBootstrap(
  raw: unknown,
): raw is { readonly bootstrap: true | BootstrapManifestConfig } & Record<string, unknown> {
  return (
    typeof raw === "object" &&
    raw !== null &&
    "bootstrap" in raw &&
    (raw as Record<string, unknown>).bootstrap !== undefined &&
    (raw as Record<string, unknown>).bootstrap !== false
  );
}

/**
 * Merges bootstrap sources into manifest context config.
 *
 * If the raw context has a `bootstrap` field, resolves .koi/ files
 * and prepends them to the explicit sources array. Returns the
 * (possibly augmented) context config for createContextExtension().
 *
 * @param rawContext - The raw manifest.context value (unknown)
 * @param manifestPath - Path to the manifest file
 * @param agentName - Agent name from manifest.name
 * @returns Augmented context config, or the original value if no bootstrap
 */
export async function mergeBootstrapContext(
  rawContext: unknown,
  manifestPath: string,
  agentName: string,
): Promise<unknown> {
  if (!hasBootstrap(rawContext)) {
    return rawContext;
  }

  const bootstrapSources = await resolveBootstrapSources(
    rawContext.bootstrap,
    manifestPath,
    agentName,
  );

  const existingSources = Array.isArray((rawContext as Record<string, unknown>).sources)
    ? ((rawContext as Record<string, unknown>).sources as readonly unknown[])
    : [];

  return { ...rawContext, sources: [...bootstrapSources, ...existingSources] };
}
