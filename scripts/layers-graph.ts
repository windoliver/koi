#!/usr/bin/env bun
/**
 * `bun run layers --graph` — ASCII dependency graph with layer annotations.
 *
 * Reads all package.json files, groups by layer, and renders an ASCII
 * dependency tree with box-drawing characters. Detects and highlights
 * layer violations (e.g., L2→L1, L2→L2 peer imports).
 *
 * Usage:
 *   bun scripts/layers-graph.ts           # Full graph
 *   bun scripts/layers-graph.ts --summary # Layer summary only
 */

import { readdir } from "node:fs/promises";
import { L0_PACKAGES, L0U_PACKAGES, L1_PACKAGES, L3_PACKAGES, L4_PACKAGES } from "./layers.js";

const PACKAGES_DIR = new URL("../packages/", import.meta.url).pathname;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PkgInfo {
  readonly name: string;
  readonly layer: string;
  readonly deps: readonly string[];
}

export interface Violation {
  readonly from: string;
  readonly fromLayer: string;
  readonly to: string;
  readonly toLayer: string;
}

// ---------------------------------------------------------------------------
// Layer classification
// ---------------------------------------------------------------------------

export function classifyLayer(name: string): string {
  if (L0_PACKAGES.has(name)) return "L0";
  if (L0U_PACKAGES.has(name)) return "L0u";
  if (L1_PACKAGES.has(name)) return "L1";
  if (L3_PACKAGES.has(name)) return "L3";
  if (L4_PACKAGES.has(name)) return "L4";
  return "L2";
}

// ---------------------------------------------------------------------------
// Violation detection
// ---------------------------------------------------------------------------

/**
 * Returns true if a dependency from `fromLayer` to `toLayer` is allowed.
 *
 * Rules:
 * - L0: no @koi/* deps
 * - L0u: only L0 and L0u
 * - L1: only L0 and L0u
 * - L2: only L0 and L0u (never L1 or peer L2)
 * - L3/L4: any layer
 */
export function isAllowedDep(fromLayer: string, toLayer: string): boolean {
  switch (fromLayer) {
    case "L0":
      return false; // L0 has zero @koi/* deps
    case "L0u":
      return toLayer === "L0" || toLayer === "L0u";
    case "L1":
      return toLayer === "L0" || toLayer === "L0u";
    case "L2":
      return toLayer === "L0" || toLayer === "L0u";
    case "L3":
    case "L4":
      return true;
    default:
      return true;
  }
}

export function detectViolations(packages: readonly PkgInfo[]): readonly Violation[] {
  const violations: Violation[] = [];

  for (const pkg of packages) {
    for (const dep of pkg.deps) {
      const depLayer = classifyLayer(dep);
      if (!isAllowedDep(pkg.layer, depLayer)) {
        violations.push({
          from: pkg.name,
          fromLayer: pkg.layer,
          to: dep,
          toLayer: depLayer,
        });
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Package scanning
// ---------------------------------------------------------------------------

async function scanPackages(): Promise<readonly PkgInfo[]> {
  const subsystems = await readdir(PACKAGES_DIR, { withFileTypes: true });
  const results: PkgInfo[] = [];

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
        dependencies?: Record<string, string>;
      };

      const koiDeps = Object.keys(pkg.dependencies ?? {}).filter((d) => d.startsWith("@koi/"));

      results.push({
        name: pkg.name,
        layer: classifyLayer(pkg.name),
        deps: koiDeps,
      });
    }
  }

  return results.sort((a, b) => {
    const layerOrder = ["L0", "L0u", "L1", "L2", "L3", "L4"];
    const aIdx = layerOrder.indexOf(a.layer);
    const bIdx = layerOrder.indexOf(b.layer);
    if (aIdx !== bIdx) return aIdx - bIdx;
    return a.name.localeCompare(b.name);
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderSummary(packages: readonly PkgInfo[]): string {
  const groups = new Map<string, number>();
  for (const pkg of packages) {
    groups.set(pkg.layer, (groups.get(pkg.layer) ?? 0) + 1);
  }

  const lines: string[] = [
    "┌──────────────────────────────────────────────┐",
    "│          Koi Monorepo Layer Summary           │",
    "├──────────────────────────────────────────────┤",
  ];

  const layerOrder = ["L0", "L0u", "L1", "L2", "L3", "L4"];
  const layerDesc: Record<string, string> = {
    L0: "Kernel (types only)",
    L0u: "Utilities (pure functions)",
    L1: "Engine runtime",
    L2: "Feature packages",
    L3: "Meta-packages",
    L4: "Distribution",
  };

  for (const layer of layerOrder) {
    const count = groups.get(layer) ?? 0;
    if (count === 0) continue;
    const desc = layerDesc[layer] ?? "";
    const countStr = String(count).padStart(4);
    lines.push(`│  ${layer.padEnd(4)} ${countStr} packages  ${desc.padEnd(24)}│`);
  }

  lines.push("├──────────────────────────────────────────────┤");
  lines.push(`│  Total: ${String(packages.length).padStart(4)} packages                       │`);
  lines.push("└──────────────────────────────────────────────┘");

  return lines.join("\n");
}

export function renderGraph(
  packages: readonly PkgInfo[],
  violations?: readonly Violation[],
): string {
  // Build a set of "from→to" pairs for quick lookup
  const violationSet = new Set<string>();
  if (violations !== undefined) {
    for (const v of violations) {
      violationSet.add(`${v.from}→${v.to}`);
    }
  }

  const lines: string[] = [];
  let currentLayer = "";

  for (const pkg of packages) {
    if (pkg.layer !== currentLayer) {
      currentLayer = pkg.layer;
      lines.push("");
      lines.push(`─── ${currentLayer} ${"─".repeat(60 - currentLayer.length)}`);
    }

    if (pkg.deps.length === 0) {
      lines.push(`  ${pkg.name}`);
      continue;
    }

    // Annotate each dep, marking violations with [!!]
    const annotatedDeps = pkg.deps.map((dep) => {
      const key = `${pkg.name}→${dep}`;
      if (violationSet.has(key)) {
        const depLayer = classifyLayer(dep);
        return `${dep} [!! ${pkg.layer}→${depLayer}]`;
      }
      return dep;
    });

    lines.push(`  ${pkg.name} → ${annotatedDeps.join(", ")}`);
  }

  // Append violation summary if any violations exist
  if (violations !== undefined && violations.length > 0) {
    lines.push("");
    lines.push(`⚠ ${String(violations.length)} layer violation(s) detected:`);
    for (const v of violations) {
      lines.push(`  ${v.from} (${v.fromLayer}) → ${v.to} (${v.toLayer})`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const summaryOnly = args.includes("--summary");

  const packages = await scanPackages();
  const violations = detectViolations(packages);

  console.log(renderSummary(packages));

  if (!summaryOnly) {
    console.log(renderGraph(packages, violations));
  } else if (violations.length > 0) {
    // Even in summary mode, report violations
    console.log(`\n⚠ ${String(violations.length)} layer violation(s) detected:`);
    for (const v of violations) {
      console.log(`  ${v.from} (${v.fromLayer}) → ${v.to} (${v.toLayer})`);
    }
  }
}

if (import.meta.main) {
  await main();
}
