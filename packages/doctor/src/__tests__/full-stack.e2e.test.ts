/**
 * Full-stack E2E test: createKoi + createPiAdapter + @koi/doctor.
 *
 * Validates that @koi/doctor correctly scans the manifest of a real agent
 * that runs through the full L1 runtime with a live LLM call.
 *
 * Scenario:
 *   1. Assemble an "insecure" agent (missing middleware, broad permissions)
 *   2. Run a single-turn LLM call to prove the runtime works
 *   3. Run @koi/doctor against the same manifest
 *   4. Verify doctor findings match the known misconfigurations
 *   5. Assemble a "secure" agent, verify doctor gives it a clean bill of health
 *
 * Gated on ANTHROPIC_API_KEY — tests are skipped when the key is not set.
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-ant-... bun test src/__tests__/full-stack.e2e.test.ts
 */

import { describe, expect, test } from "bun:test";
import type { AgentManifest, EngineEvent, KoiMiddleware } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import { createDoctor } from "../runner.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const describeE2E = HAS_KEY ? describe : describe.skip;

const TIMEOUT_MS = 60_000;
const E2E_MODEL = "anthropic:claude-haiku-4-5-20251001";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

function extractText(events: readonly EngineEvent[]): string {
  return events
    .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
    .map((e) => e.delta)
    .join("");
}

// ---------------------------------------------------------------------------
// Manifests
// ---------------------------------------------------------------------------

const INSECURE_MANIFEST: AgentManifest = {
  name: "insecure-e2e-agent",
  version: "1.0.0",
  model: { name: "claude-haiku" },
  tools: [{ name: "exec" }, { name: "eval" }],
  middleware: [{ name: "memory" }],
  permissions: { allow: ["*"] },
  delegation: { enabled: true, maxChainDepth: 10, defaultTtlMs: 172_800_000 },
};

const SECURE_MANIFEST: AgentManifest = {
  name: "secure-e2e-agent",
  version: "1.0.0",
  model: { name: "claude-haiku", options: { defense: true } },
  tools: [{ name: "read_file" }],
  middleware: [
    { name: "sanitize" },
    { name: "guardrails" },
    { name: "sandbox" },
    { name: "permissions" },
    { name: "call-limits" },
    { name: "compactor" },
    { name: "turn-ack" },
    { name: "audit" },
    { name: "governance" },
    { name: "memory" },
  ],
  permissions: {
    allow: ["read_file"],
    deny: ["exec"],
    ask: ["read_file"],
  },
  delegation: { enabled: true, maxChainDepth: 3, defaultTtlMs: 3_600_000 },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("full-stack e2e: createKoi + Pi adapter + @koi/doctor", () => {
  test(
    "insecure agent runs through full runtime, doctor catches misconfigurations",
    async () => {
      // --- Step 1: Build and run the real agent ---
      const piAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a concise test assistant. Reply briefly.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: INSECURE_MANIFEST,
        adapter: piAdapter,
        loopDetection: false,
        limits: { maxTurns: 2, maxDurationMs: 55_000, maxTokens: 3_000 },
      });

      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Reply with exactly one word: pong" }),
      );

      // Verify real LLM output
      const text = extractText(events);
      expect(text.toLowerCase()).toContain("pong");
      expect(runtime.agent.state).toBe("terminated");

      await runtime.dispose();

      // --- Step 2: Run doctor against the same manifest ---
      const doctor = createDoctor({
        manifest: INSECURE_MANIFEST,
        envKeys: new Set([]),
      });
      const report = await doctor.run();

      // Insecure manifest should be unhealthy
      expect(report.healthy).toBe(false);
      expect(report.findings.length).toBeGreaterThan(10);

      // Specific findings we know should fire:
      const ruleNames = report.findings.map((f) => f.rule);

      // ASI01 — missing sanitize/guardrails middleware
      expect(ruleNames).toContain("goal-hijack:missing-sanitize-middleware");
      expect(ruleNames).toContain("goal-hijack:missing-guardrails-middleware");

      // ASI02 — wildcard permissions, dangerous tools
      expect(ruleNames).toContain("tool-misuse:wildcard-allow");
      expect(ruleNames).toContain("tool-misuse:dangerous-tool-names");

      // ASI05 — missing sandbox/permissions middleware
      expect(ruleNames).toContain("code-execution:missing-sandbox-middleware");
      expect(ruleNames).toContain("code-execution:no-permissions-middleware");

      // ASI07 — unsigned delegation grants, excessive chain depth, long TTL
      expect(ruleNames).toContain("insecure-delegation:unsigned-grants");
      expect(ruleNames).toContain("insecure-delegation:excessive-chain-depth");
      expect(ruleNames).toContain("insecure-delegation:long-ttl");

      // ASI06 — memory without sanitize
      expect(ruleNames).toContain("memory-poisoning:memory-without-sanitize");

      // ASI08 — no call-limits
      expect(ruleNames).toContain("cascading-failures:no-call-limits");

      // ASI09 — no audit trail
      expect(ruleNames).toContain("human-trust:no-audit-trail");

      // ASI10 — no governance with delegation enabled
      expect(ruleNames).toContain("rogue-agents:no-governance");

      // OWASP summary covers all 10 categories
      for (const entry of report.owaspSummary) {
        expect(entry.findingCount).toBeGreaterThan(0);
      }
    },
    TIMEOUT_MS,
  );

  test(
    "secure agent runs through full runtime, doctor gives clean bill of health",
    async () => {
      // --- Step 1: Build and run the real agent ---
      const piAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a concise test assistant.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: SECURE_MANIFEST,
        adapter: piAdapter,
        loopDetection: false,
        limits: { maxTurns: 2, maxDurationMs: 55_000, maxTokens: 3_000 },
      });

      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Reply with exactly one word: secure" }),
      );

      // Verify real LLM output
      const text = extractText(events);
      expect(text.toLowerCase()).toContain("secure");
      expect(runtime.agent.state).toBe("terminated");

      await runtime.dispose();

      // --- Step 2: Run doctor against the same manifest ---
      const doctor = createDoctor({
        manifest: SECURE_MANIFEST,
        envKeys: new Set(["DELEGATION_SECRET"]),
      });
      const report = await doctor.run();

      // Secure manifest should be healthy
      expect(report.healthy).toBe(true);

      // No CRITICAL or HIGH findings
      const criticalOrHigh = report.findings.filter(
        (f) => f.severity === "CRITICAL" || f.severity === "HIGH",
      );
      expect(criticalOrHigh).toHaveLength(0);
    },
    TIMEOUT_MS,
  );

  test(
    "middleware chain is visible to doctor via manifest (observer middleware intercepts LLM call)",
    async () => {
      // let justified: tracks whether middleware actually intercepted
      let modelStreamIntercepted = false;

      const observerMiddleware: KoiMiddleware = {
        name: "e2e:observer",
        priority: 500,
        async *wrapModelStream(_ctx, req, next) {
          modelStreamIntercepted = true;
          yield* next(req);
        },
      };

      const manifest: AgentManifest = {
        name: "observed-e2e-agent",
        version: "1.0.0",
        model: { name: "claude-haiku" },
        middleware: [{ name: "sanitize" }, { name: "guardrails" }],
      };

      const piAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a concise test assistant.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest,
        adapter: piAdapter,
        middleware: [observerMiddleware],
        loopDetection: false,
        limits: { maxTurns: 2, maxDurationMs: 55_000, maxTokens: 3_000 },
      });

      await collectEvents(runtime.run({ kind: "text", text: "Reply with exactly: observed" }));

      // Middleware chain worked — our observer saw the model stream
      expect(modelStreamIntercepted).toBe(true);
      expect(runtime.agent.state).toBe("terminated");

      await runtime.dispose();

      // Doctor sees the manifest middleware declarations
      const doctor = createDoctor({ manifest });
      const report = await doctor.run();

      // sanitize + guardrails present → those rules should NOT fire
      const ruleNames = report.findings.map((f) => f.rule);
      expect(ruleNames).not.toContain("goal-hijack:missing-sanitize-middleware");
      expect(ruleNames).not.toContain("goal-hijack:missing-guardrails-middleware");
    },
    TIMEOUT_MS,
  );

  test(
    "advisory callback receives real dependency data alongside LLM-tested agent",
    async () => {
      const piAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a concise test assistant.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: INSECURE_MANIFEST,
        adapter: piAdapter,
        loopDetection: false,
        limits: { maxTurns: 2, maxDurationMs: 55_000, maxTokens: 3_000 },
      });

      await collectEvents(runtime.run({ kind: "text", text: "Reply with: advisory-test" }));
      await runtime.dispose();

      // let justified: tracks whether advisory callback was invoked with deps
      let callbackInvoked = false;

      const doctor = createDoctor({
        manifest: INSECURE_MANIFEST,
        envKeys: new Set([]),
        dependencies: [
          { name: "lodash", version: "4.17.20", isDev: false },
          { name: "event-stream", version: "3.3.6", isDev: false },
        ],
        advisoryCallback: (deps) => {
          callbackInvoked = true;
          // Advisory callback receives the deps we passed in
          expect(deps).toHaveLength(2);
          const vulnerable = deps.filter((d) => d.name === "lodash");
          return vulnerable.length > 0
            ? [
                {
                  rule: "advisory:lodash-prototype-pollution",
                  severity: "HIGH" as const,
                  category: "SUPPLY_CHAIN" as const,
                  message: "lodash < 4.17.21 has prototype pollution (CVE-2021-23337)",
                  owasp: ["ASI04" as const],
                },
              ]
            : [];
        },
      });

      const report = await doctor.run();

      expect(callbackInvoked).toBe(true);
      expect(report.findings.some((f) => f.rule === "advisory:lodash-prototype-pollution")).toBe(
        true,
      );

      // Also fires the built-in known-vulnerable-patterns rule for event-stream
      expect(report.findings.some((f) => f.rule === "supply-chain:known-vulnerable-patterns")).toBe(
        true,
      );
    },
    TIMEOUT_MS,
  );

  test(
    "severity overrides work with real agent manifest",
    async () => {
      const piAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a concise test assistant.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: INSECURE_MANIFEST,
        adapter: piAdapter,
        loopDetection: false,
        limits: { maxTurns: 2, maxDurationMs: 55_000, maxTokens: 3_000 },
      });

      await collectEvents(runtime.run({ kind: "text", text: "Reply with: override-test" }));
      await runtime.dispose();

      // Downgrade wildcard-allow from CRITICAL to LOW, then filter at HIGH threshold
      const doctor = createDoctor({
        manifest: INSECURE_MANIFEST,
        envKeys: new Set([]),
        severityThreshold: "HIGH",
        severityOverrides: { "tool-misuse:wildcard-allow": "LOW" },
      });
      const report = await doctor.run();

      // wildcard-allow should be filtered out (overridden to LOW, threshold is HIGH)
      expect(report.findings.some((f) => f.rule === "tool-misuse:wildcard-allow")).toBe(false);

      // Other HIGH/CRITICAL findings should still be present
      expect(report.findings.length).toBeGreaterThan(0);
      for (const finding of report.findings) {
        expect(["HIGH", "CRITICAL"]).toContain(finding.severity);
      }
    },
    TIMEOUT_MS,
  );
});
