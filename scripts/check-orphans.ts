#!/usr/bin/env bun
/**
 * CI enforcement — detects orphaned L2 packages with zero internal consumers.
 *
 * An orphaned L2 package is one that no other workspace package lists as a
 * dependency or devDependency. This catches packages that were added but
 * never wired into the system, or that lost all consumers after refactoring.
 *
 * Checked layers:
 *   - L0u: curated utilities — should still have consumers
 *   - L2:  feature packages — the main proliferation risk
 *
 * Exempt layers:
 *   - L0 (@koi/core): the kernel, everything depends on it
 *   - L1: engine runtime, consumed by apps/L3 directly
 *   - L3/L4: leaf consumers, not consumed by other packages
 *
 * A package with `"koi": { "optional": true }` in its package.json is exempt —
 * it may be consumed at assembly time via dependency injection (e.g., by L3
 * harness packages) without a static package.json dependency.
 *
 * Usage: bun scripts/check-orphans.ts
 */

import { L0_PACKAGES, L1_PACKAGES, L3_PACKAGES, L4_PACKAGES } from "./layers.js";

const ROOT = new URL("../", import.meta.url).pathname;

interface PackageInfo {
  readonly name: string;
  readonly path: string;
  readonly dependencies: readonly string[];
  readonly devDependencies: readonly string[];
  readonly optional: boolean;
}

function isExemptLayer(name: string): boolean {
  return (
    L0_PACKAGES.has(name) || L1_PACKAGES.has(name) || L3_PACKAGES.has(name) || L4_PACKAGES.has(name)
  );
}

function getKoiDeps(deps: Record<string, string> | undefined): readonly string[] {
  if (deps === undefined) return [];
  return Object.keys(deps).filter((d) => d.startsWith("@koi/"));
}

async function collectPackages(): Promise<readonly PackageInfo[]> {
  const packages: PackageInfo[] = [];
  const glob = new Bun.Glob("packages/*/*/package.json");

  for await (const path of glob.scan({ cwd: ROOT, absolute: true })) {
    try {
      const parsed = (await Bun.file(path).json()) as {
        readonly name?: string;
        readonly dependencies?: Record<string, string>;
        readonly devDependencies?: Record<string, string>;
        readonly koi?: { readonly optional?: boolean };
      };
      if (parsed.name === undefined) continue;

      packages.push({
        name: parsed.name,
        path,
        dependencies: getKoiDeps(parsed.dependencies),
        devDependencies: getKoiDeps(parsed.devDependencies),
        optional: parsed.koi?.optional === true,
      });
    } catch {
      // Skip unreadable package.json files
    }
  }

  return packages;
}

async function main(): Promise<void> {
  const packages = await collectPackages();

  // Build set of all consumed @koi/* packages (deps + devDeps across all workspaces)
  const consumed = new Set<string>();
  for (const pkg of packages) {
    for (const dep of pkg.dependencies) {
      consumed.add(dep);
    }
    for (const dep of pkg.devDependencies) {
      consumed.add(dep);
    }
  }

  // Also check root package.json
  try {
    const rootPkg = (await Bun.file(`${ROOT}package.json`).json()) as {
      readonly dependencies?: Record<string, string>;
      readonly devDependencies?: Record<string, string>;
    };
    for (const dep of getKoiDeps(rootPkg.dependencies)) {
      consumed.add(dep);
    }
    for (const dep of getKoiDeps(rootPkg.devDependencies)) {
      consumed.add(dep);
    }
  } catch {
    // Root package.json read failure is not fatal
  }

  // Find L0u/L2 packages with zero consumers
  const orphans: string[] = [];
  const optionalNoConsumer: string[] = [];
  let checkedCount = 0;

  for (const pkg of packages) {
    if (!pkg.name.startsWith("@koi/")) continue;
    if (isExemptLayer(pkg.name)) continue;

    // This is an L0u or L2 package
    checkedCount++;

    const hasConsumer = consumed.has(pkg.name);

    if (pkg.optional && !hasConsumer) {
      optionalNoConsumer.push(pkg.name);
      continue;
    }
    if (hasConsumer) continue;

    orphans.push(pkg.name);
  }

  // Always report optional packages with no consumers (informational)
  if (optionalNoConsumer.length > 0) {
    console.log(`\n${optionalNoConsumer.length} optional package(s) with no static consumer:\n`);
    for (const name of optionalNoConsumer.sort()) {
      console.log(`  ⚬ ${name}`);
    }
  }

  if (orphans.length > 0) {
    console.log(`\n${orphans.length} orphaned package(s) with zero consumers:\n`);
    for (const name of orphans.sort()) {
      console.log(`  ✗ ${name}`);
    }
    console.log(
      '\n  Fix: add a consumer, mark as optional ("koi": { "optional": true }), or archive.\n',
    );
    process.exit(1);
  }

  console.log(
    `\n✅ All ${checkedCount} L0u/L2 packages have at least one consumer (or are marked optional).`,
  );
}

await main();
