#!/usr/bin/env bun
/**
 * Generates documentation and CI configuration from the canonical layer registry.
 *
 * Outputs:
 *   1. .github/labeler.yml   — PR auto-labeler config (layer:L0, L1, L0u, L2, L3 globs)
 *   2. Koi.md L0u paragraph  — the auto-generated L0u package list section
 *
 * Both outputs are deterministic (alphabetically sorted).
 *
 * Usage:
 *   bun scripts/generate-layer-docs.ts          # write outputs to disk
 *   bun scripts/check-doc-sync.ts               # verify outputs match disk (CI gate)
 */

import { L0U_PACKAGES, L3_PACKAGES } from "./layers.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Strips the @koi/ scope to get the directory/package-name segment. */
function toDir(pkg: string): string {
  return pkg.slice("@koi/".length);
}

/** Returns a sorted copy of a set's entries. */
function sorted(set: ReadonlySet<string>): readonly string[] {
  return [...set].sort();
}

// ---------------------------------------------------------------------------
// labeler.yml generator
// ---------------------------------------------------------------------------

/**
 * Generates the full content of .github/labeler.yml from the canonical layer registry.
 * Produces deterministic output (alphabetically sorted within each section).
 */
export function generateLabelerYml(
  l0uPackages: ReadonlySet<string>,
  l3Packages: ReadonlySet<string>,
): string {
  const l0uDirs = sorted(l0uPackages).map(toDir);
  const l3Dirs = sorted(l3Packages).map(toDir);

  const l0uEntries = l0uDirs.map((d) => `      - "packages/**/${d}/**"`).join("\n");
  const l3Entries = l3Dirs.map((d) => `      - "packages/**/${d}/**"`).join("\n");

  // L2 catch-all excludes L0 (core), L1 (engine), all L0u, and all L3 dirs.
  const excludedDirs = ["core", "engine", ...l0uDirs, ...l3Dirs].sort();
  const l2Exclusions = excludedDirs.map((d) => `      - "!packages/**/${d}/**"`).join("\n");

  return `# PR auto-labeler — assigns layer labels based on changed files.
# Used by .github/workflows/label-layers.yml (actions/labeler@v5).
# See docs/architecture/Koi.md for layer definitions.
#
# ⚠️  AUTO-GENERATED — do not edit by hand.
# Source of truth: scripts/layers.ts (L0U_PACKAGES, L3_PACKAGES)
# To regenerate: bun scripts/generate-layer-docs.ts
# To verify in CI: bun scripts/check-doc-sync.ts

"layer:L0":
  - changed-files:
    - any-glob-to-any-file: "packages/kernel/core/**"

"layer:L1":
  - changed-files:
    - any-glob-to-any-file: "packages/kernel/engine/**"

"layer:L0u":
  - changed-files:
    - any-glob-to-any-file:
${l0uEntries}

"layer:L3":
  - changed-files:
    - any-glob-to-any-file:
${l3Entries}

# L2 is the catch-all: any package change that is not L0, L1, L0u, or L3.
# The negation patterns prevent L0/L1/L0u/L3 package changes from also triggering L2.
"layer:L2":
  - changed-files:
    - any-glob-to-any-file:
      - "packages/**"
${l2Exclusions}
`;
}

// ---------------------------------------------------------------------------
// Koi.md L0u paragraph generator
// ---------------------------------------------------------------------------

/**
 * Generates the L0u package list paragraph for docs/architecture/Koi.md.
 * Matches the format of the existing paragraph so the check-doc-sync can locate and
 * compare it by looking for the opening sentinel line.
 */
export function generateL0uDocParagraph(l0uPackages: ReadonlySet<string>): string {
  const pkgList = sorted(l0uPackages)
    .map((p) => `\`${p}\``)
    .join(", ");

  return `**L0-utility packages** (${l0uPackages.size} total — canonical list lives in \`scripts/layers.ts\` → \`L0U_PACKAGES\`):
${pkgList}.`;
}

// ---------------------------------------------------------------------------
// Writer — used when running as a script
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const repoRoot = new URL("../", import.meta.url).pathname;

  const labelerPath = `${repoRoot}.github/labeler.yml`;
  const koiMdPath = `${repoRoot}docs/architecture/Koi.md`;

  // Write labeler.yml
  const labelerContent = generateLabelerYml(L0U_PACKAGES, L3_PACKAGES);
  await Bun.write(labelerPath, labelerContent);
  console.log(
    `✅ Written: .github/labeler.yml (${L0U_PACKAGES.size} L0u + ${L3_PACKAGES.size} L3 packages)`,
  );

  // Patch Koi.md: replace the L0u paragraph (sentinel line → end of paragraph)
  const koiMd = await Bun.file(koiMdPath).text();
  const newParagraph = generateL0uDocParagraph(L0U_PACKAGES);
  const patchedMd = patchL0uParagraph(koiMd, newParagraph);

  if (patchedMd === koiMd) {
    console.log("ℹ️  Koi.md L0u paragraph already up to date — no changes.");
  } else {
    await Bun.write(koiMdPath, patchedMd);
    console.log(`✅ Updated: docs/architecture/Koi.md L0u paragraph`);
  }
}

/**
 * Replaces the L0u paragraph in Koi.md content.
 * Locates the paragraph by its sentinel `**L0-utility packages**` heading line and
 * replaces through the closing period of the package list (which may span multiple lines).
 */
export function patchL0uParagraph(koiMdContent: string, newParagraph: string): string {
  const lines = koiMdContent.split("\n");
  const startIdx = lines.findIndex((l) => l.startsWith("**L0-utility packages**"));
  if (startIdx === -1) return koiMdContent; // sentinel not found — no change

  // Walk forward through the package list lines (they all contain `@koi/` references).
  // The last line of the list ends with a period.
  let endIdx = startIdx + 1;
  while (endIdx < lines.length) {
    const line = lines[endIdx] ?? "";
    if (!line.includes("@koi/")) break; // left the package list
    endIdx++;
    if (line.trimEnd().endsWith(".")) break; // last package list line
  }

  return [...lines.slice(0, startIdx), newParagraph, ...lines.slice(endIdx)].join("\n");
}

if (import.meta.main) {
  await main();
}
