#!/usr/bin/env bun
/**
 * Build-time descriptor manifest generator.
 *
 * Scans the monorepo packages directory for BrickDescriptor exports and
 * serializes their metadata (excluding factory functions) into a JSON
 * manifest at packages/fs/resolve/src/descriptor-manifest.json.
 *
 * The manifest enables static resolution at runtime — targeted imports
 * instead of filesystem scanning — which is required for standalone binaries.
 *
 * Usage: bun scripts/generate-descriptor-manifest.ts
 */

import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ManifestEntry } from "../packages/fs/resolve/src/discover-static.js";

const MONOREPO_ROOT = new URL("..", import.meta.url).pathname;
const PACKAGES_DIR = resolve(MONOREPO_ROOT, "packages");
const OUTPUT_PATH = resolve(MONOREPO_ROOT, "packages/fs/resolve/src/descriptor-manifest.json");

/** Package directory name patterns that may export descriptors (mirrors discover.ts). */
const DISCOVERABLE_PREFIXES: readonly string[] = ["middleware-", "channel-", "engine-", "search-"];

/** Packages to skip during discovery (mirrors discover.ts). */
const SKIP_LIST = new Set([
  "middleware-guardrails",
  "middleware-feedback-loop",
  "middleware-event-trace",
  "middleware-fs-rollback",
]);

function isDiscoverablePackage(name: string): boolean {
  return DISCOVERABLE_PREFIXES.some((prefix) => name.startsWith(prefix)) && !SKIP_LIST.has(name);
}

interface DescriptorShape {
  readonly kind: string;
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly optionsValidator: unknown;
  readonly factory: unknown;
}

function isDescriptor(value: unknown): value is DescriptorShape {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.kind === "string" &&
    typeof obj.name === "string" &&
    typeof obj.optionsValidator === "function" &&
    typeof obj.factory === "function"
  );
}

async function discoverPackageDirs(packagesDir: string): Promise<readonly string[]> {
  const entries = await readdir(packagesDir, { encoding: "utf8", withFileTypes: true });
  const dirs: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    if (isDiscoverablePackage(entry.name)) {
      dirs.push(join(packagesDir, entry.name));
      continue;
    }

    // Check nested category directories
    const categoryDir = join(packagesDir, entry.name);
    let nestedEntries: Dirent[];
    try {
      nestedEntries = await readdir(categoryDir, { encoding: "utf8", withFileTypes: true });
    } catch {
      continue;
    }

    for (const nestedEntry of nestedEntries) {
      if (!nestedEntry.isDirectory() || !isDiscoverablePackage(nestedEntry.name)) {
        continue;
      }
      dirs.push(join(categoryDir, nestedEntry.name));
    }
  }

  dirs.sort();
  return dirs;
}

async function main(): Promise<void> {
  console.log("Scanning packages directory for descriptor exports...");

  const packageDirs = await discoverPackageDirs(PACKAGES_DIR);

  console.log(`Found ${String(packageDirs.length)} discoverable package(s). Importing...`);

  const entries: ManifestEntry[] = [];

  const results = await Promise.allSettled(
    packageDirs.map(async (packageDir) => {
      const distIndex = join(packageDir, "dist", "index.js");
      try {
        const mod = await import(distIndex);
        if (isDescriptor(mod.descriptor)) {
          return { descriptor: mod.descriptor, packagePath: packageDir };
        }
        return undefined;
      } catch {
        // Package not built or no descriptor — skip
        return undefined;
      }
    }),
  );

  for (const result of results) {
    if (result.status !== "fulfilled" || result.value === undefined) continue;

    const { descriptor, packagePath } = result.value;
    const entry: ManifestEntry = {
      kind: descriptor.kind as ManifestEntry["kind"],
      name: descriptor.name,
      ...(descriptor.aliases !== undefined && descriptor.aliases.length > 0
        ? { aliases: [...descriptor.aliases] }
        : {}),
      ...(descriptor.description !== undefined ? { description: descriptor.description } : {}),
      ...(descriptor.tags !== undefined && descriptor.tags.length > 0
        ? { tags: [...descriptor.tags] }
        : {}),
      packagePath,
    };
    entries.push(entry);
  }

  // Sort by kind, then name for deterministic output
  entries.sort((a, b) => {
    const kindCmp = a.kind.localeCompare(b.kind);
    if (kindCmp !== 0) return kindCmp;
    return a.name.localeCompare(b.name);
  });

  const manifest = { descriptors: entries };
  const json = `${JSON.stringify(manifest, null, 2)}\n`;

  await Bun.write(OUTPUT_PATH, json);

  console.log(`Wrote manifest with ${String(entries.length)} descriptor(s) to ${OUTPUT_PATH}`);

  // Summary table
  for (const entry of entries) {
    const aliases = entry.aliases !== undefined ? ` (aliases: ${entry.aliases.join(", ")})` : "";
    console.log(`  ${entry.kind}/${entry.name}${aliases}`);
  }
}

await main();
