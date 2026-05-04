#!/usr/bin/env bun
/**
 * Integration demo: shows how a downstream consumer (e.g. forge-tools'
 * forge_tool) would wrap synthesized output with @koi/forge-verifier.
 *
 * Models the realistic flow:
 *   1. Synthesize a draft "tool" (a code string + JSON schema)
 *   2. Run a verification pipeline:
 *        - syntax     : implementation parses as JS
 *        - schema     : inputSchema is a structurally valid JSON Schema
 *        - selftest   : implementation runs against a probe input
 *   3. Stamp ForgeProvenance.verification with the result
 *
 * Run: bun packages/lib/forge-verifier/scripts/integration-demo.ts
 */

import { createMemoryCache, runPipeline, type VerifierStage } from "../src/index.js";

interface DraftTool {
  readonly name: string;
  readonly version: string;
  readonly implementation: string;
  readonly inputSchema: Record<string, unknown>;
  readonly probeInput: Record<string, unknown>;
}

const syntaxStage: VerifierStage<DraftTool> = {
  name: "syntax",
  version: "1",
  run: (a) => {
    try {
      // biome-ignore lint/security/noGlobalEval: stage logic intentionally evaluates synthesized code
      new Function("input", a.implementation);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: `syntax error: ${(e as Error).message}` };
    }
  },
};

const schemaStage: VerifierStage<DraftTool> = {
  name: "schema",
  version: "1",
  run: (a) => {
    if (typeof a.inputSchema !== "object" || a.inputSchema === null) {
      return { ok: false, reason: "inputSchema must be an object" };
    }
    if (a.inputSchema.type !== "object") {
      return { ok: false, reason: "inputSchema.type must be 'object'" };
    }
    return { ok: true };
  },
};

const selftestStage: VerifierStage<DraftTool> = {
  name: "selftest",
  version: "1",
  sandboxed: true, // pretend this runs in an isolated worker
  run: async (a) => {
    try {
      const fn = new Function("input", a.implementation) as (i: unknown) => unknown;
      const out = fn(a.probeInput);
      if (out === undefined) {
        return { ok: false, reason: "implementation returned undefined for probe input" };
      }
      return { ok: true, sandboxed: true };
    } catch (e) {
      return { ok: false, reason: `runtime error: ${(e as Error).message}` };
    }
  },
};

// --- Demo runs ---

const cache = createMemoryCache();
const opts = {
  cache,
  namespace: "forge-tools/demo-tenant",
  acknowledgeTrustedCache: true as const,
  executionContextKey: "demo-ctx-v1",
};

const ok: DraftTool = {
  name: "double",
  version: "0.0.1",
  implementation: "return input.x * 2",
  inputSchema: { type: "object", properties: { x: { type: "number" } } },
  probeInput: { x: 21 },
};

const badSyntax: DraftTool = {
  ...ok,
  name: "broken",
  implementation: "return input.x **",
};

const badSchema: DraftTool = {
  ...ok,
  name: "noschema",
  inputSchema: { type: "string" },
};

const stages = [syntaxStage, schemaStage, selftestStage];

console.log("─".repeat(60));
console.log("forge-verifier integration demo");
console.log("─".repeat(60));

for (const tool of [ok, badSyntax, badSchema]) {
  const result = await runPipeline(stages, tool, opts);
  if (result.ok) {
    const summary = result.value;
    console.log(
      `✓ ${tool.name.padEnd(10)} passed=${summary.passed} sandbox=${summary.sandbox} ` +
        `total=${summary.totalDurationMs}ms stages=${summary.stageResults.length}`,
    );
  } else {
    console.log(`✗ ${tool.name.padEnd(10)} ${result.error.code}: ${result.error.message}`);
  }
}

// Cache hit demo
console.log("\nrepeating 'double' (should be cache hit, no stage execution):");
const t0 = performance.now();
const cached = await runPipeline(stages, ok, opts);
const t1 = performance.now();
if (cached.ok) {
  console.log(
    `✓ double     passed=${cached.value.passed} sandbox=${cached.value.sandbox} ` +
      `wall=${(t1 - t0).toFixed(2)}ms (cache served)`,
  );
}

console.log("─".repeat(60));
console.log("Wiring point in forge-tools:");
console.log("  - in tools/forge-tool.ts, before buildProvenance(),");
console.log("    call runPipeline(stages, draftArtifact, opts) and");
console.log("    fold the resulting ForgeVerificationSummary into");
console.log("    provenance.verification (currently hardcoded passed:false).");
console.log("─".repeat(60));
