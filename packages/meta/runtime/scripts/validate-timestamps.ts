#!/usr/bin/env bun

/**
 * Validates that all golden trajectory fixtures have monotonically
 * non-decreasing timestamps across all steps.
 *
 * Usage: bun run packages/meta/runtime/scripts/validate-timestamps.ts
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURES = join(import.meta.dirname, "../fixtures");

interface TrajectoryStep {
  readonly stepIndex: number;
  readonly timestamp: string | number;
}

interface Trajectory {
  readonly document_id: string;
  readonly steps: readonly TrajectoryStep[];
  readonly fixture_type?: string;
}

const files = readdirSync(FIXTURES).filter((f) => f.endsWith(".trajectory.json"));
// let: mutable — accumulates failures across all files
let totalFailures = 0;
// let: mutable — tracks files with non-monotonic timestamps
let filesWithIssues = 0;

console.log(`Checking ${files.length} trajectory fixtures for monotonic timestamps...\n`);

for (const file of files.sort()) {
  const raw = readFileSync(join(FIXTURES, file), "utf-8");
  const traj: Trajectory = JSON.parse(raw) as Trajectory;

  if (traj.fixture_type === "manual") {
    console.log(`  ⏭  ${file} — manual fixture, skipped`);
    continue;
  }

  const steps = traj.steps;
  // let: mutable — tracks violations per file
  let violations = 0;

  for (let i = 1; i < steps.length; i++) {
    const prev = steps[i - 1];
    const curr = steps[i];
    if (prev === undefined || curr === undefined) continue;

    const prevTs =
      typeof prev.timestamp === "string" ? new Date(prev.timestamp).getTime() : prev.timestamp;
    const currTs =
      typeof curr.timestamp === "string" ? new Date(curr.timestamp).getTime() : curr.timestamp;

    if (currTs <= prevTs) {
      if (violations === 0) {
        console.log(`  ❌ ${file}`);
      }
      console.log(
        `     step ${prev.stepIndex} (${prevTs}) > step ${curr.stepIndex} (${currTs}) — delta: ${currTs - prevTs}ms`,
      );
      violations++;
    }
  }

  if (violations > 0) {
    totalFailures += violations;
    filesWithIssues++;
  } else {
    console.log(`  ✅ ${file} — ${steps.length} steps, all monotonic`);
  }
}

console.log(
  `\n${totalFailures === 0 ? "✅ All fixtures have monotonic timestamps." : `❌ ${totalFailures} violation(s) in ${filesWithIssues} file(s).`}`,
);
process.exit(totalFailures === 0 ? 0 : 1);
