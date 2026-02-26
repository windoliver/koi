#!/usr/bin/env bun
/**
 * CI enforcement — verifies that all middleware packages export a `descriptor`.
 *
 * Scans `packages/middleware-*` directories, imports each package,
 * and checks for a `descriptor` export of the correct shape.
 *
 * Skip-list: packages that require complex runtime-only services
 * with no YAML representation.
 *
 * Usage: bun scripts/check-descriptors.ts
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";

const PACKAGES_DIR = new URL("../packages/", import.meta.url).pathname;

/** Packages that intentionally skip descriptor export. */
const SKIP_LIST = new Set([
  "middleware-integration",
  "middleware-guardrails",
  "middleware-feedback-loop",
  "middleware-event-trace",
  "middleware-fs-rollback",
]);

interface CheckResult {
  readonly pkg: string;
  readonly ok: boolean;
  readonly reason?: string;
}

async function checkPackage(dirName: string): Promise<CheckResult> {
  const pkgJsonPath = join(PACKAGES_DIR, dirName, "package.json");
  const pkg = `@koi/${dirName}`;

  try {
    const pkgJson = await Bun.file(pkgJsonPath).json();
    const name = pkgJson.name as string;

    // Try to import the built package
    const distIndex = join(PACKAGES_DIR, dirName, "dist", "index.js");
    const indexFile = Bun.file(distIndex);
    const exists = await indexFile.exists();

    if (!exists) {
      return { pkg: name, ok: false, reason: "dist/index.js not found — run build first" };
    }

    const mod = await import(distIndex);

    if (mod.descriptor === undefined) {
      return { pkg: name, ok: false, reason: "no 'descriptor' export found" };
    }

    const desc = mod.descriptor;
    if (typeof desc.kind !== "string") {
      return { pkg: name, ok: false, reason: "descriptor.kind is not a string" };
    }
    if (typeof desc.name !== "string") {
      return { pkg: name, ok: false, reason: "descriptor.name is not a string" };
    }
    if (typeof desc.optionsValidator !== "function") {
      return { pkg: name, ok: false, reason: "descriptor.optionsValidator is not a function" };
    }
    if (typeof desc.factory !== "function") {
      return { pkg: name, ok: false, reason: "descriptor.factory is not a function" };
    }

    return { pkg: name, ok: true };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return { pkg, ok: false, reason: `import failed: ${message}` };
  }
}

async function main(): Promise<void> {
  const entries = await readdir(PACKAGES_DIR);
  const middlewareDirs = entries
    .filter((e) => e.startsWith("middleware-"))
    .filter((e) => !SKIP_LIST.has(e))
    .sort();

  console.log(`Checking ${middlewareDirs.length} middleware packages for descriptor export...\n`);

  const results = await Promise.all(middlewareDirs.map(checkPackage));

  const passed: CheckResult[] = [];
  const failed: CheckResult[] = [];

  for (const result of results) {
    if (result.ok) {
      passed.push(result);
    } else {
      failed.push(result);
    }
  }

  for (const r of passed) {
    console.log(`  ✓ ${r.pkg}`);
  }

  if (failed.length > 0) {
    console.log("");
    for (const r of failed) {
      console.log(`  ✗ ${r.pkg}: ${r.reason}`);
    }
    console.log(`\n${failed.length} package(s) missing descriptor export.`);
    process.exit(1);
  }

  console.log(`\nAll ${passed.length} middleware packages have valid descriptor exports.`);
}

await main();
