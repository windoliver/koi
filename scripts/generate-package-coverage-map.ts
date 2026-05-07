#!/usr/bin/env bun
/**
 * Generate docs/package-coverage-map.md from the active workspace packages.
 *
 * This intentionally scans only active two-level package manifests. Archived v1 sources
 * and reviewed external repositories are review material, not active packages.
 */

import { existsSync, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname;

interface PackageEntry {
  readonly name: string;
  readonly description: string;
  readonly family: string;
  readonly relDir: string;
  readonly testCount: number;
  readonly docs: readonly string[];
}

interface PackageJson {
  readonly name?: string;
  readonly description?: string;
}

function countTests(dir: string): number {
  let count = 0;
  function visit(path: string): void {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name === "dist" || entry.name === "node_modules" || entry.name === ".turbo") {
        continue;
      }
      const next = join(path, entry.name);
      if (entry.isDirectory()) {
        visit(next);
        continue;
      }
      if (/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(entry.name)) {
        count += 1;
      }
    }
  }
  visit(dir);
  return count;
}

function packageDocs(dirName: string): readonly string[] {
  const candidates = [`docs/L2/${dirName}.md`, `docs/L3/${dirName}.md`, `docs/L4/${dirName}.md`];
  return candidates.filter((path) => existsSync(join(ROOT, path)));
}

function cleanDescription(value: string | undefined): string {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized !== undefined && normalized.length > 0 ? normalized : "(no description)";
}

function byFamilyThenName(a: PackageEntry, b: PackageEntry): number {
  const family = a.family.localeCompare(b.family);
  return family !== 0 ? family : a.name.localeCompare(b.name);
}

async function collectPackages(): Promise<readonly PackageEntry[]> {
  const glob = new Bun.Glob("packages/*/*/package.json");
  const entries: PackageEntry[] = [];

  for await (const absPath of glob.scan({ cwd: ROOT, absolute: true })) {
    const pkg = (await Bun.file(absPath).json()) as PackageJson;
    if (pkg.name === undefined) continue;

    const relPath = relative(ROOT, absPath);
    const parts = relPath.split("/");
    const family = parts[1] ?? "unknown";
    const dirName = parts[2] ?? basename(absPath);
    const relDir = `packages/${family}/${dirName}`;
    const absDir = join(ROOT, relDir);

    entries.push({
      name: pkg.name,
      description: cleanDescription(pkg.description),
      family,
      relDir,
      testCount: countTests(absDir),
      docs: packageDocs(dirName),
    });
  }

  return entries.sort(byFamilyThenName);
}

function render(entries: readonly PackageEntry[]): string {
  const families = new Map<string, readonly PackageEntry[]>();
  for (const entry of entries) {
    families.set(entry.family, [...(families.get(entry.family) ?? []), entry]);
  }

  const familyRows = [...families.entries()]
    .map(([family, familyEntries]) => {
      const tests = familyEntries.reduce((sum, entry) => sum + entry.testCount, 0);
      const docs = familyEntries.filter((entry) => entry.docs.length > 0).length;
      return `| ${family} | ${familyEntries.length} | ${tests} | ${docs} |`;
    })
    .join("\n");

  const inventory = [...families.entries()]
    .map(([family, familyEntries]) => {
      const rows = familyEntries
        .map((entry) => {
          const docs = entry.docs.length > 0 ? entry.docs.join(", ") : "-";
          return `- \`${entry.name}\` (${entry.relDir}) - ${entry.description}. Tests: ${entry.testCount}. Docs: ${docs}.`;
        })
        .join("\n");
      return `## ${family} (${familyEntries.length})\n\n${rows}`;
    })
    .join("\n\n");

  return `# Package Coverage Map

Generated from active workspace packages with \`bun scripts/generate-package-coverage-map.ts\`.

Current snapshot:

- ${entries.length} workspace packages
- ${families.size} package families
- ${entries.filter((entry) => entry.testCount > 0).length} packages with local test files
- ${entries.filter((entry) => entry.docs.length > 0).length} packages with dedicated package docs

## Family Summary

| Family | Packages | Test files | Dedicated package docs |
| --- | ---: | ---: | ---: |
${familyRows}

## Package Inventory

Each line shows package name, package directory, package description, test-file count, and existing package doc paths.

${inventory}
`;
}

export async function generatePackageCoverageMap(): Promise<string> {
  return render(await collectPackages());
}

if (import.meta.main) {
  await Bun.write(join(ROOT, "docs/package-coverage-map.md"), await generatePackageCoverageMap());
}
