#!/usr/bin/env bun

/**
 * CI gate: verifies that generated files (.github/labeler.yml and the Koi.md L0u paragraph)
 * match what would be produced by scripts/generate-layer-docs.ts.
 *
 * Fails with exit code 1 and a diff if any file is stale.
 * Run locally after editing scripts/layers.ts: bun scripts/generate-layer-docs.ts
 *
 * Usage: bun scripts/check-doc-sync.ts
 */

import {
  generateL0uDocParagraph,
  generateLabelerYml,
  patchL0uParagraph,
} from "./generate-layer-docs.js";
import { L0U_PACKAGES, L3_PACKAGES } from "./layers.js";

const repoRoot = new URL("../", import.meta.url).pathname;

interface SyncError {
  readonly file: string;
  readonly expected: string;
  readonly actual: string;
}

async function checkLabelerYml(): Promise<SyncError | null> {
  const expected = generateLabelerYml(L0U_PACKAGES, L3_PACKAGES);
  const actual = await Bun.file(`${repoRoot}.github/labeler.yml`).text();
  if (actual === expected) return null;
  return { file: ".github/labeler.yml", expected, actual };
}

async function checkKoiMdL0uParagraph(): Promise<SyncError | null> {
  const koiMd = await Bun.file(`${repoRoot}docs/architecture/Koi.md`).text();
  const newParagraph = generateL0uDocParagraph(L0U_PACKAGES);
  const expectedMd = patchL0uParagraph(koiMd, newParagraph);
  if (koiMd === expectedMd) return null;
  // Show just the paragraph diff, not the full file
  return {
    file: "docs/architecture/Koi.md (L0u paragraph)",
    expected: newParagraph,
    actual: "paragraph in file does not match generated output",
  };
}

async function main(): Promise<void> {
  const errors = (await Promise.all([checkLabelerYml(), checkKoiMdL0uParagraph()])).filter(
    (e): e is SyncError => e !== null,
  );

  if (errors.length === 0) {
    console.log("✅ Doc sync check passed — all generated files are up to date.");
    process.exit(0);
  }

  console.error("❌ Generated files are out of sync with scripts/layers.ts:\n");
  for (const err of errors) {
    console.error(`  ${err.file}`);
    console.error(
      `  Expected:\n${err.expected
        .split("\n")
        .slice(0, 8)
        .map((l) => `    ${l}`)
        .join("\n")}`,
    );
    console.error(`  Actual:\n    ${err.actual.split("\n")[0] ?? ""}\n`);
  }
  console.error("  → Run: bun scripts/generate-layer-docs.ts");
  process.exit(1);
}

if (import.meta.main) {
  await main();
}
