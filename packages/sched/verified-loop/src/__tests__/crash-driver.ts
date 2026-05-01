/**
 * Test fixture: a child-process driver for crash-recovery testing.
 *
 * Spawned by crash-recovery.test.ts. Runs a verified loop against a PRD
 * supplied via argv, with a slow verify gate so the parent can SIGKILL
 * the child mid-iteration. Writes a marker file each time an iteration
 * completes so the parent knows when to kill.
 */

import { createVerifiedLoop } from "../verified-loop.js";

const prdPath = process.argv[2];
const markerPath = process.argv[3];
const slowMs = Number(process.argv[4] ?? "200");

if (!prdPath || !markerPath) {
  console.error("usage: crash-driver.ts <prdPath> <markerPath> [slowMs]");
  process.exit(2);
}

const loop = createVerifiedLoop({
  prdPath,
  runIteration: async function* () {
    // Empty stream — the iteration "work" is the gate sleep below.
  },
  verify: async (ctx) => {
    // Tell the parent that iteration N has just finished its work step.
    await Bun.write(`${markerPath}.${ctx.iteration}`, "1");
    // Block long enough that the parent can SIGKILL us during this gate call.
    await new Promise((r) => setTimeout(r, slowMs));
    return { passed: true };
  },
  iterationPrompt: (ctx) => `iteration ${ctx.iteration}: ${ctx.currentItem?.id}`,
  maxIterations: 100,
});

await loop.run();
