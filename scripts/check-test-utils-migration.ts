#!/usr/bin/env bun
/**
 * Track migration progress from @koi/test-utils barrel to split packages.
 *
 * Reports how many packages still depend on the transitional barrel
 * and lists them. Exit code 0 always (informational only).
 *
 * Usage: bun scripts/check-test-utils-migration.ts
 */

import { readdir } from "node:fs/promises";

const PACKAGES_DIR = new URL("../packages/", import.meta.url).pathname;

async function main(): Promise<void> {
  const subsystems = await readdir(PACKAGES_DIR, { withFileTypes: true });
  const consumers: string[] = [];

  for (const sub of subsystems) {
    if (!sub.isDirectory()) continue;
    const subPath = `${PACKAGES_DIR}${sub.name}`;
    const children = await readdir(subPath, { withFileTypes: true });

    for (const child of children) {
      if (!child.isDirectory()) continue;
      const pkgPath = `${subPath}/${child.name}/package.json`;
      const file = Bun.file(pkgPath);
      if (!(await file.exists())) continue;

      const pkg = (await file.json()) as {
        name: string;
        devDependencies?: Record<string, string>;
      };

      // Skip the test-utils packages themselves
      if (pkg.name.startsWith("@koi/test-utils")) continue;

      if (pkg.devDependencies !== undefined && "@koi/test-utils" in pkg.devDependencies) {
        consumers.push(pkg.name);
      }
    }
  }

  consumers.sort();

  if (consumers.length === 0) {
    console.log("✅ All packages have migrated from @koi/test-utils barrel!");
    console.log("   Safe to remove the transitional re-exports.");
    return;
  }

  console.log(`📦 @koi/test-utils migration: ${String(consumers.length)} package(s) remaining\n`);
  console.log("Migrate devDependency to one or more of:");
  console.log("  - @koi/test-utils-contracts  (conformance suites)");
  console.log("  - @koi/test-utils-mocks      (mock implementations)");
  console.log("  - @koi/test-utils-store-contracts (storage backend tests)\n");

  console.log("Packages still using @koi/test-utils:");
  for (const name of consumers) {
    console.log(`  ${name}`);
  }
}

if (import.meta.main) {
  await main();
}
