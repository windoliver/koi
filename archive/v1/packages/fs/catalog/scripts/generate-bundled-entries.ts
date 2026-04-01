#!/usr/bin/env bun
/**
 * generate-bundled-entries.ts — Build-time script to generate bundled catalog entries.
 *
 * Reads packages/∗/package.json and optional koi.catalog.json sidecar files
 * to produce a TypeScript source file with curated CatalogEntry objects.
 *
 * Two discovery modes:
 *
 * 1. **Sidecar mode** (preferred): Reads koi.catalog.json for explicit metadata.
 *    Sidecar format:
 *      { "kind": "middleware", "description": "...", "tags": ["..."] }
 *
 * 2. **Naming-pattern mode** (fallback): Infers kind from directory name:
 *      middleware-* → middleware
 *      channel-*   → channel
 *      engine-*    → tool (engine adapter)
 *      sandbox-*   → tool (sandbox provider)
 *      tool-*      → tool
 *      tools-*     → tool
 *
 * Packages in SKIP_PACKAGES are excluded (L0, L0u, L1, L3, internal infra).
 *
 * Usage:
 *   bun run packages/catalog/scripts/generate-bundled-entries.ts
 *   bun run packages/catalog/scripts/generate-bundled-entries.ts --check
 *
 * --check mode: Prints packages NOT covered by bundled-entries.ts (CI lint).
 */

import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CatalogSidecar {
  readonly kind: string;
  readonly description: string;
  readonly tags?: readonly string[];
}

interface DiscoveredPackage {
  readonly name: string;
  readonly dirName: string;
  readonly inferredKind: string | undefined;
  readonly sidecar: CatalogSidecar | undefined;
}

interface GeneratedEntry {
  readonly name: string;
  readonly kind: string;
  readonly source: "bundled";
  readonly description: string;
  readonly tags: readonly string[];
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** L0, L0u, L1, L3, and internal-only packages to skip. */
const SKIP_PACKAGES = new Set([
  "@koi/core",
  "@koi/engine",
  "@koi/errors",
  "@koi/hash",
  "@koi/manifest",
  "@koi/validation",
  "@koi/shutdown",
  "@koi/test-utils",
  "@koi/starter",
  "@koi/channel-base",
  "@koi/snapshot-chain-store",
  "@koi/catalog",
  "@koi/sqlite-utils",
  "@koi/skill-scanner",
]);

/** Infer BrickKind from directory name prefix. */
function inferKind(dirName: string): string | undefined {
  if (dirName.startsWith("middleware-")) return "middleware";
  if (dirName.startsWith("channel-")) return "channel";
  if (dirName.startsWith("engine-")) return "tool";
  if (dirName.startsWith("sandbox")) return "tool";
  if (dirName.startsWith("tool-")) return "tool";
  if (dirName.startsWith("tools-")) return "tool";
  return undefined;
}

/** Generate a fallback description from the package name. */
function fallbackDescription(_packageName: string, dirName: string): string {
  // Strip @koi/ prefix and convert hyphens to spaces
  const humanName = dirName.replace(/-/g, " ");
  const kind = inferKind(dirName);
  if (kind === "middleware") return `${humanName} middleware`;
  if (kind === "channel") return `${humanName} channel adapter`;
  return humanName;
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

const PACKAGES_DIR = resolve(import.meta.dir, "../../");

async function scanPackages(): Promise<readonly DiscoveredPackage[]> {
  const packageDirs = await readdir(join(PACKAGES_DIR), { withFileTypes: true });
  const packages: DiscoveredPackage[] = [];

  for (const dir of packageDirs) {
    if (!dir.isDirectory()) continue;

    const packageJsonPath = join(PACKAGES_DIR, dir.name, "package.json");
    const sidecarPath = join(PACKAGES_DIR, dir.name, "koi.catalog.json");

    // Read package.json for the name
    const packageJsonFile = Bun.file(packageJsonPath);
    if (!(await packageJsonFile.exists())) continue;

    const packageJson = (await packageJsonFile.json()) as { readonly name?: string };
    const packageName = packageJson.name;
    if (packageName === undefined) continue;

    // Skip infrastructure packages
    if (SKIP_PACKAGES.has(packageName)) continue;

    // Check for sidecar
    const sidecarFile = Bun.file(sidecarPath);
    const sidecar = (await sidecarFile.exists())
      ? ((await sidecarFile.json()) as CatalogSidecar)
      : undefined;

    packages.push({
      name: packageName,
      dirName: dir.name,
      inferredKind: inferKind(dir.name),
      sidecar,
    });
  }

  return packages.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Generate entries from discovered packages
// ---------------------------------------------------------------------------

function toEntry(pkg: DiscoveredPackage): GeneratedEntry | undefined {
  const kind = pkg.sidecar?.kind ?? pkg.inferredKind;
  if (kind === undefined) return undefined; // Can't determine kind — skip

  const description = pkg.sidecar?.description ?? fallbackDescription(pkg.name, pkg.dirName);
  const tags = pkg.sidecar?.tags ?? [];

  return {
    name: `bundled:${pkg.name}`,
    kind,
    source: "bundled",
    description,
    tags,
  };
}

// ---------------------------------------------------------------------------
// Generate source
// ---------------------------------------------------------------------------

function generateSource(generatedEntries: readonly GeneratedEntry[]): string {
  const lines = [
    "/**",
    " * Auto-generated bundled catalog entries.",
    " *",
    ` * Generated at: ${new Date().toISOString()}`,
    ` * Source packages discovered: ${String(generatedEntries.length)}`,
    " *",
    " * To regenerate: bun run packages/catalog/scripts/generate-bundled-entries.ts",
    " */",
    "",
    'import type { CatalogEntry } from "@koi/core";',
    "",
    "export const GENERATED_ENTRIES: readonly CatalogEntry[] = [",
  ];

  for (const entry of generatedEntries) {
    const tagsStr = entry.tags.map((t) => `"${t}"`).join(", ");
    lines.push("  {");
    lines.push(`    name: "${entry.name}",`);
    lines.push(`    kind: "${entry.kind}",`);
    lines.push(`    source: "${entry.source}",`);
    lines.push(`    description: "${entry.description}",`);
    if (entry.tags.length > 0) {
      lines.push(`    tags: [${tagsStr}],`);
    }
    lines.push("  },");
  }

  lines.push("] as const satisfies readonly CatalogEntry[];");
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Check mode: report packages not covered by bundled-entries.ts
// ---------------------------------------------------------------------------

async function checkCoverage(packages: readonly DiscoveredPackage[]): Promise<void> {
  // Dynamic import of bundled entries
  const bundledModule = await import("../src/bundled-entries.js");
  const bundledEntries = bundledModule.BUNDLED_ENTRIES as readonly { readonly name: string }[];
  const coveredNames = new Set(bundledEntries.map((e) => e.name));

  const uncovered = packages.filter((pkg) => {
    const kind = pkg.sidecar?.kind ?? pkg.inferredKind;
    if (kind === undefined) return false; // Can't determine kind — not a discoverable capability
    return !coveredNames.has(`bundled:${pkg.name}`);
  });

  if (uncovered.length === 0) {
    console.log("All discoverable packages are covered by bundled-entries.ts.");
    return;
  }

  console.log(`\n${String(uncovered.length)} discoverable packages NOT in bundled-entries.ts:\n`);
  for (const pkg of uncovered) {
    const kind = pkg.sidecar?.kind ?? pkg.inferredKind ?? "?";
    console.log(`  ${pkg.name} (kind: ${kind})`);
  }
  console.log(
    "\nAdd these to packages/catalog/src/bundled-entries.ts or create koi.catalog.json sidecars.\n",
  );
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const isCheck = process.argv.includes("--check");
  const packages = await scanPackages();

  if (isCheck) {
    await checkCoverage(packages);
    return;
  }

  // Generate mode
  const entries = packages.map(toEntry).filter((e): e is GeneratedEntry => e !== undefined);

  if (entries.length === 0) {
    console.log("No discoverable packages found.");
    return;
  }

  const source = generateSource(entries);
  const outputPath = resolve(import.meta.dir, "../src/generated-entries.ts");
  await Bun.write(outputPath, source);

  console.log(`Generated ${String(entries.length)} entries → ${outputPath}`);

  // Also report packages that couldn't be inferred
  const skipped = packages.filter((p) => p.sidecar === undefined && p.inferredKind === undefined);
  if (skipped.length > 0) {
    console.log(`\n${String(skipped.length)} packages skipped (kind not inferrable):`);
    for (const pkg of skipped) {
      console.log(`  ${pkg.name}`);
    }
    console.log("\nTo include them, add a koi.catalog.json sidecar in their directory.");
  }
}

await main();
