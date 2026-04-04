#!/usr/bin/env bun
/**
 * CI gate: L2 packages wired into L3 meta-packages must have up-to-date docs.
 *
 * Rules enforced:
 * 1. Every L2 dependency of an L3 package must have a docs/L2/<name>.md file.
 * 2. When the L3 wiring changes (package.json modified), the corresponding
 *    docs/L2/<name>.md must have been updated in the same branch — otherwise
 *    the doc is considered stale for this PR.
 *
 * "Stale" is detected by comparing git log timestamps:
 *   - Last commit touching docs/L2/<name>.md on this branch
 *   - Last commit touching the L3 package.json that added/changed the dep
 * If the L3 wiring was touched more recently than the doc, the doc is stale.
 *
 * Usage: bun scripts/check-doc-wiring.ts
 * CI: runs on every PR via ci.yml
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { L0_PACKAGES, L0U_PACKAGES, L1_PACKAGES, L3_PACKAGES, L4_PACKAGES } from "./layers.js";

const ROOT = new URL("../", import.meta.url).pathname.replace(/\/$/, "");

// L3 meta-packages that wire L2 packages
const L3_META_PACKAGE_JSONS: readonly string[] = [
  "packages/meta/runtime/package.json",
  "packages/meta/cli/package.json",
].filter((p) => existsSync(`${ROOT}/${p}`));

function isL2(name: string): boolean {
  return (
    !L0_PACKAGES.has(name) &&
    !L0U_PACKAGES.has(name) &&
    !L1_PACKAGES.has(name) &&
    !L3_PACKAGES.has(name) &&
    !L4_PACKAGES.has(name)
  );
}

/** Returns the unix timestamp (seconds) of the last commit touching a path, or 0 if never committed. */
function lastCommitTime(relPath: string): number {
  try {
    const out = execSync(`git log -1 --format=%ct -- "${relPath}"`, {
      cwd: ROOT,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return out.length > 0 ? Number(out) : 0;
  } catch {
    return 0;
  }
}

/** Returns the package directory name from a package name, e.g. @koi/event-trace → event-trace */
function dirNameFromPackageName(name: string): string {
  return name.replace(/^@koi\//, "");
}

interface WiringIssue {
  readonly kind: "missing" | "stale";
  readonly package: string;
  readonly docPath: string;
  readonly l3PackageJson: string;
  readonly detail: string;
}

async function checkL3PackageJson(l3RelPath: string): Promise<readonly WiringIssue[]> {
  const fullPath = `${ROOT}/${l3RelPath}`;
  if (!existsSync(fullPath)) return [];

  const parsed = (await Bun.file(fullPath).json()) as {
    readonly dependencies?: Record<string, string>;
  };
  const deps = Object.keys(parsed.dependencies ?? {});
  const l2Deps = deps.filter((d) => d.startsWith("@koi/") && isL2(d));

  const l3WiringTime = lastCommitTime(l3RelPath);

  const issues: WiringIssue[] = [];

  for (const dep of l2Deps) {
    const dirName = dirNameFromPackageName(dep);
    const docRelPath = `docs/L2/${dirName}.md`;
    const docFullPath = `${ROOT}/${docRelPath}`;

    // Rule 1: doc must exist
    if (!existsSync(docFullPath)) {
      issues.push({
        kind: "missing",
        package: dep,
        docPath: docRelPath,
        l3PackageJson: l3RelPath,
        detail: `${dep} is wired into ${l3RelPath} but ${docRelPath} does not exist`,
      });
      continue;
    }

    // Rule 2: if the L3 wiring was touched more recently than the doc, flag as stale
    // Only enforce this when running in CI on a PR branch (not on main)
    if (l3WiringTime > 0) {
      const docTime = lastCommitTime(docRelPath);
      if (docTime === 0 || l3WiringTime > docTime) {
        // Check if the L3 package.json was actually changed on THIS branch
        // (i.e., differs from the merge-base) to avoid false positives on main
        try {
          const mergeBase = execSync("git merge-base HEAD origin/main", {
            cwd: ROOT,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          }).trim();
          const changedOnBranch = execSync(
            `git diff --name-only "${mergeBase}"...HEAD -- "${l3RelPath}"`,
            { cwd: ROOT, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
          ).trim();
          if (changedOnBranch.length > 0) {
            // L3 wiring changed on this branch — check if doc was also updated
            const docChangedOnBranch = execSync(
              `git diff --name-only "${mergeBase}"...HEAD -- "${docRelPath}"`,
              { cwd: ROOT, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
            ).trim();
            if (docChangedOnBranch.length === 0) {
              issues.push({
                kind: "stale",
                package: dep,
                docPath: docRelPath,
                l3PackageJson: l3RelPath,
                detail:
                  `${l3RelPath} was updated on this branch (wiring changed for ${dep}) ` +
                  `but ${docRelPath} was not updated. Update the doc to reflect the change.`,
              });
            }
          }
        } catch {
          // git unavailable or not on a branch — skip staleness check
        }
      }
    }
  }

  return issues;
}

async function main(): Promise<void> {
  const allIssues: WiringIssue[] = [];

  for (const l3PkgJson of L3_META_PACKAGE_JSONS) {
    const issues = await checkL3PackageJson(l3PkgJson);
    allIssues.push(...issues);
  }

  const missing = allIssues.filter((i) => i.kind === "missing");
  const stale = allIssues.filter((i) => i.kind === "stale");

  if (missing.length === 0 && stale.length === 0) {
    const checked = L3_META_PACKAGE_JSONS.length;
    console.log(
      `✅ Doc wiring check passed — all L2 deps in ${checked} L3 package(s) have up-to-date docs.`,
    );
    process.exit(0);
  }

  if (missing.length > 0) {
    console.error(`❌ ${missing.length} L2 package(s) wired into L3 but missing documentation:\n`);
    for (const i of missing) {
      console.error(`  ✗ ${i.package}`);
      console.error(`    Wired in: ${i.l3PackageJson}`);
      console.error(`    Missing:  ${i.docPath}`);
      console.error(`    → Create ${i.docPath} before wiring into L3.\n`);
    }
  }

  if (stale.length > 0) {
    console.error(
      `❌ ${stale.length} L2 package doc(s) stale — L3 wiring changed but doc not updated:\n`,
    );
    for (const i of stale) {
      console.error(`  ✗ ${i.package}`);
      console.error(`    ${i.detail}\n`);
    }
    console.error(
      "  → Update the docs/L2/<name>.md file(s) to reflect the wiring change before merging.",
    );
  }

  process.exit(1);
}

await main();
