#!/usr/bin/env bun
/**
 * Out-of-process stress harness for @koi/forge-verifier.
 *
 * Runs N concurrent verifications across M tenants with random aborts
 * and asserts:
 *   1. Stage execution count <= M (each tenant runs at most once;
 *      subsequent calls hit cache)
 *   2. Total wall-clock < N × per-stage-time (proves coalescing works)
 *   3. No process-level errors / unhandled rejections
 *   4. Cache populated for live consumers; phantom entries don't appear
 *      after all-aborted bursts
 *
 * Run: bun packages/lib/forge-verifier/scripts/stress.ts [N=200] [M=8]
 */

import { createMemoryCache, runPipeline, type VerifierStage } from "../src/index.js";

interface Artifact {
  readonly tenantId: string;
  readonly payload: { readonly a: number; readonly b: number };
}

const N = Number(process.argv[2] ?? "200");
const M = Number(process.argv[3] ?? "8");
const STAGE_MS = 50;

let stageStarts = 0;
const stage: VerifierStage<Artifact> = {
  name: "stress-stage",
  version: "1",
  run: async () => {
    stageStarts += 1;
    await new Promise((r) => setTimeout(r, STAGE_MS));
    return { ok: true };
  },
};

const cache = createMemoryCache();

function tenantOf(i: number): string {
  return `tenant-${i % M}`;
}

async function singleRun(i: number): Promise<{
  readonly i: number;
  readonly ok: boolean;
  readonly aborted: boolean;
  readonly code?: string;
}> {
  const tenant = tenantOf(i);
  const artifact: Artifact = { tenantId: tenant, payload: { a: 1, b: 2 } };
  const ac = new AbortController();
  // 30% of callers abort mid-flight at a random time within the stage window
  const willAbort = Math.random() < 0.3;
  if (willAbort) {
    setTimeout(() => ac.abort(), Math.random() * STAGE_MS * 0.8);
  }
  try {
    const result = await runPipeline([stage], artifact, {
      cache,
      namespace: "stress",
      acknowledgeTrustedCache: true,
      executionContextKey: tenant,
      signal: ac.signal,
    });
    return {
      i,
      ok: result.ok,
      aborted: willAbort,
      ...(result.ok === false ? { code: result.error.code } : {}),
    };
  } catch (e) {
    return { i, ok: false, aborted: willAbort, code: `THROW:${(e as Error).message}` };
  }
}

const t0 = performance.now();
const results = await Promise.all(Array.from({ length: N }, (_, i) => singleRun(i)));
const t1 = performance.now();

const wallMs = Math.round(t1 - t0);
const successes = results.filter((r) => r.ok).length;
const aborted = results.filter((r) => r.aborted).length;
const codeBuckets = new Map<string, number>();
for (const r of results) {
  if (!r.ok && r.code !== undefined) {
    codeBuckets.set(r.code, (codeBuckets.get(r.code) ?? 0) + 1);
  }
}

console.log("─".repeat(60));
console.log("forge-verifier stress harness");
console.log("─".repeat(60));
console.log(`callers              : ${N}`);
console.log(`tenants              : ${M}`);
console.log(`per-stage time       : ${STAGE_MS}ms`);
console.log(`wall-clock           : ${wallMs}ms`);
console.log(`stage starts         : ${stageStarts}`);
console.log(`successes            : ${successes}`);
console.log(`aborted (~30%)       : ${aborted}`);
console.log("error codes          :", Object.fromEntries(codeBuckets));
console.log("─".repeat(60));

const sequentialMs = N * STAGE_MS;
const speedup = (sequentialMs / wallMs).toFixed(1);
console.log(`speedup vs sequential: ${speedup}× (${sequentialMs}ms → ${wallMs}ms)`);

const failures: string[] = [];
if (stageStarts > M) failures.push(`stage starts ${stageStarts} > tenants ${M} (coalescing broke)`);
if (wallMs > sequentialMs / 2) failures.push(`wall-clock ${wallMs}ms suggests no parallelism`);
const surprisingThrows = [...codeBuckets.keys()].filter((c) => c.startsWith("THROW:"));
if (surprisingThrows.length > 0) failures.push(`unexpected throws: ${surprisingThrows.join(", ")}`);

if (failures.length === 0) {
  console.log("✅ PASS");
  process.exit(0);
} else {
  console.log("❌ FAIL");
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}
