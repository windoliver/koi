#!/usr/bin/env bun
/**
 * CI gate: every active L2 package must have a corresponding docs/L2/<name>.md.
 *
 * Scans active workspace packages, identifies those classified as L2 (feature
 * packages not in L0, L0u, L1, L3, or L4 sets), and verifies a doc file exists.
 *
 * Usage: bun scripts/check-doc-gate.ts
 */

import { existsSync } from "node:fs";
import { L0_PACKAGES, L0U_PACKAGES, L1_PACKAGES, L3_PACKAGES, L4_PACKAGES } from "./layers.js";

const ROOT = new URL("../", import.meta.url).pathname;

function isL2(name: string): boolean {
  return (
    !L0_PACKAGES.has(name) &&
    !L0U_PACKAGES.has(name) &&
    !L1_PACKAGES.has(name) &&
    !L3_PACKAGES.has(name) &&
    !L4_PACKAGES.has(name)
  );
}

async function main(): Promise<void> {
  const pkgGlob = new Bun.Glob("packages/*/*/package.json");
  const missing: string[] = [];
  let l2Count = 0;

  for await (const path of pkgGlob.scan({ cwd: ROOT, absolute: true })) {
    const parsed = (await Bun.file(path).json()) as { readonly name?: string };
    const name = parsed.name;
    if (name === undefined) continue;
    if (!isL2(name)) continue;

    l2Count++;
    // Derive doc filename from the package directory name
    const dirName = path.split("/").at(-2);
    if (dirName === undefined) continue;

    const docPath = `${ROOT}docs/L2/${dirName}.md`;
    if (!existsSync(docPath)) {
      missing.push(`${name} → docs/L2/${dirName}.md`);
    }
  }

  if (missing.length > 0) {
    console.error(`❌ ${missing.length} L2 package(s) missing documentation:\n`);
    for (const m of missing) {
      console.error(`  ✗ ${m}`);
    }
    console.error("\n  → Create the missing docs/L2/<name>.md file(s).");
    process.exit(1);
  }

  console.log(`✅ Doc gate passed — ${l2Count} L2 package(s) all have docs.`);
}

await main();
