#!/usr/bin/env bun
/**
 * CI gate: L2 package and L3 wiring documentation freshness.
 *
 * Rule 1 — L2 doc freshness:
 *   Any L2 package modified on this branch must have its docs/L2/<name>.md
 *   updated in the same branch. Ensures docs stay in sync with code changes.
 *
 * Rule 2 — L3 runtime doc freshness:
 *   The L3 meta-package docs (docs/L3/runtime.md, docs/L3/cli.md) must reflect
 *   all currently integrated L2 packages. When any L2 dep is added, removed, or
 *   its package is modified on this branch, the corresponding L3 doc must also
 *   be updated.
 *
 * Staleness detection: compares git diff --name-only against merge-base so
 * these checks only fire on PRs that actually touched the relevant files.
 *
 * Usage: bun scripts/check-doc-wiring.ts
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { L0_PACKAGES, L0U_PACKAGES, L1_PACKAGES, L3_PACKAGES, L4_PACKAGES } from "./layers.js";

const ROOT = new URL("../", import.meta.url).pathname.replace(/\/$/, "");

/** Map from L3 package name to its doc path */
const L3_DOC_MAP: ReadonlyMap<string, string> = new Map([
  ["@koi/runtime", "docs/L3/runtime.md"],
  ["@koi/cli", "docs/L3/cli.md"],
]);

/** Map from L3 package name to its package.json path */
const L3_PACKAGE_JSON_MAP: ReadonlyMap<string, string> = new Map([
  ["@koi/runtime", "packages/meta/runtime/package.json"],
  ["@koi/cli", "packages/meta/cli/package.json"],
]);

function isL2(name: string): boolean {
  return (
    !L0_PACKAGES.has(name) &&
    !L0U_PACKAGES.has(name) &&
    !L1_PACKAGES.has(name) &&
    !L3_PACKAGES.has(name) &&
    !L4_PACKAGES.has(name)
  );
}

function dirNameFromPackageName(name: string): string {
  return name.replace(/^@koi\//, "");
}

/** Returns files changed on this branch vs merge-base. Empty string if not in a PR context. */
function branchChangedFiles(): ReadonlySet<string> {
  try {
    const mergeBase = execSync("git merge-base HEAD origin/main", {
      cwd: ROOT,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    const out = execSync(`git diff --name-only "${mergeBase}"...HEAD`, {
      cwd: ROOT,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return new Set(out.length > 0 ? out.split("\n") : []);
  } catch {
    return new Set();
  }
}

/** Returns all L2 package names and their source directories that were touched on this branch. */
function changedL2Packages(changed: ReadonlySet<string>): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const file of changed) {
    // Match packages in packages/*/  directories (not kernel/core, kernel/engine*, meta/*)
    const m = file.match(/^packages\/[^/]+\/([^/]+)\//);
    if (!m) continue;
    const dirName = m[1];
    if (dirName === undefined) continue;
    // Read package.json to get the @koi/* name
    const pkgJsonPath = `${ROOT}/packages/${file.split("/")[1]}/${dirName}/package.json`;
    if (!existsSync(pkgJsonPath)) continue;
    try {
      const parsed = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as {
        readonly name?: string;
      };
      const name = parsed.name;
      if (name === undefined || !name.startsWith("@koi/")) continue;
      if (!isL2(name)) continue;
      result.set(name, `packages/${file.split("/")[1]}/${dirName}`);
    } catch {
      // ignore unreadable package.json
    }
  }
  return result;
}

/** Returns L2 deps of an L3 package (from its package.json). */
async function l2DepsOf(l3PkgJsonPath: string): Promise<readonly string[]> {
  const full = `${ROOT}/${l3PkgJsonPath}`;
  if (!existsSync(full)) return [];
  const parsed = (await Bun.file(full).json()) as {
    readonly dependencies?: Record<string, string>;
  };
  return Object.keys(parsed.dependencies ?? {}).filter((d) => d.startsWith("@koi/") && isL2(d));
}

interface DocIssue {
  readonly kind: "missing-l2-doc" | "stale-l2-doc" | "stale-l3-doc" | "missing-l3-doc";
  readonly detail: string;
  readonly fix: string;
}

async function main(): Promise<void> {
  const changed = branchChangedFiles();

  // If not in a PR context (no origin/main reachable), skip staleness checks
  if (changed.size === 0) {
    console.log("✅ Doc wiring check skipped — not in a PR context (no changed files detected).");
    process.exit(0);
  }

  const issues: DocIssue[] = [];

  // ─────────────────────────────────────────────────────────────────────────
  // Rule 1: Any L2 package modified on this branch must have docs/L2/<name>.md
  //         updated on the same branch.
  // ─────────────────────────────────────────────────────────────────────────
  const changedL2 = changedL2Packages(changed);

  for (const [pkgName] of changedL2) {
    const dirName = dirNameFromPackageName(pkgName);
    const docRelPath = `docs/L2/${dirName}.md`;
    const docFullPath = `${ROOT}/${docRelPath}`;

    if (!existsSync(docFullPath)) {
      issues.push({
        kind: "missing-l2-doc",
        detail: `${pkgName} was modified on this branch but docs/L2/${dirName}.md does not exist.`,
        fix: `Create docs/L2/${dirName}.md documenting what this package does and its public API.`,
      });
    } else if (!changed.has(docRelPath)) {
      issues.push({
        kind: "stale-l2-doc",
        detail: `${pkgName} was modified on this branch but docs/L2/${dirName}.md was not updated.`,
        fix: `Update docs/L2/${dirName}.md to reflect the changes made to ${pkgName}.`,
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Rule 2: The L3 runtime/cli doc must be updated when:
  //   (a) Any L2 dep is added to or removed from the L3 package.json, OR
  //   (b) Any currently-wired L2 package was modified on this branch.
  // ─────────────────────────────────────────────────────────────────────────
  for (const [l3Name, l3PkgJson] of L3_PACKAGE_JSON_MAP) {
    if (!existsSync(`${ROOT}/${l3PkgJson}`)) continue;

    const l3DocPath = L3_DOC_MAP.get(l3Name);
    if (l3DocPath === undefined) continue;

    const l3WiringChanged = changed.has(l3PkgJson);
    const l2Deps = await l2DepsOf(l3PkgJson);
    const wiredL2ModifiedOnBranch = l2Deps.some((dep) => changedL2.has(dep));

    const needsL3DocUpdate = l3WiringChanged || wiredL2ModifiedOnBranch;
    if (!needsL3DocUpdate) continue;

    const l3DocExists = existsSync(`${ROOT}/${l3DocPath}`);
    if (!l3DocExists) {
      issues.push({
        kind: "missing-l3-doc",
        detail:
          `${l3Name} wiring or an integrated L2 package changed on this branch, ` +
          `but ${l3DocPath} does not exist.`,
        fix: `Create ${l3DocPath} listing all integrated L2 packages and their roles.`,
      });
    } else if (!changed.has(l3DocPath)) {
      const reason = l3WiringChanged
        ? `${l3PkgJson} (wiring) was changed`
        : `an integrated L2 package (${[...changedL2.keys()].filter((k) => l2Deps.includes(k)).join(", ")}) was modified`;
      issues.push({
        kind: "stale-l3-doc",
        detail: `${l3Name}: ${reason} on this branch but ${l3DocPath} was not updated.`,
        fix: `Update ${l3DocPath} to reflect the current set of integrated L2 packages and any behavioral changes.`,
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Report
  // ─────────────────────────────────────────────────────────────────────────
  if (issues.length === 0) {
    console.log(
      "✅ Doc wiring check passed — all modified L2 packages and L3 wiring have up-to-date docs.",
    );
    process.exit(0);
  }

  console.error(`❌ ${issues.length} doc wiring issue(s) found:\n`);
  for (const issue of issues) {
    const tag =
      issue.kind === "missing-l2-doc" || issue.kind === "missing-l3-doc" ? "MISSING" : "STALE";
    console.error(`  [${tag}] ${issue.detail}`);
    console.error(`          → ${issue.fix}\n`);
  }
  process.exit(1);
}

await main();
