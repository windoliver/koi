#!/usr/bin/env bun

/**
 * Manual E2E: URL navigation security — Pi agent + real LLM call.
 *
 * Validates that the security layer implemented in url-security.ts works
 * end-to-end: real Anthropic API call → agent tries to navigate → security
 * blocks/allows → LLM receives the AI-friendly error and reasons about it.
 *
 * Tests:
 *   1.  private IPv4 blocked       — agent tries 192.168.1.1, gets PERMISSION
 *   2.  cloud metadata blocked     — agent tries 169.254.169.254, gets PERMISSION
 *   3.  IPv6 private blocked       — agent tries [::1], gets PERMISSION
 *   4.  protocol blocked           — agent tries file://, gets PERMISSION
 *   5.  domain allowlist: blocked  — domain outside list gets PERMISSION
 *   6.  domain allowlist: allowed  — domain on list navigates successfully
 *   7.  no security config         — public URL navigates with no security layer
 *   8.  tab_new private IP blocked — tab_new with 10.0.0.1 URL gets PERMISSION
 *   9.  AI reads the error         — LLM response mentions the blocked hostname
 *  10.  Teredo blocked             — agent tries [2001:0:4136:e378::8007:8], PERMISSION
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... bun scripts/e2e-browser-security.ts
 */

import { createPlaywrightBrowserDriver } from "../packages/drivers/browser-playwright/src/playwright-browser-driver.js";
import { createPiAdapter } from "../packages/drivers/engine-pi/src/adapter.js";
import { createBrowserProvider } from "../packages/fs/tool-browser/src/browser-component-provider.js";
import type { compileNavigationSecurity } from "../packages/fs/tool-browser/src/url-security.js";
import { createKoi } from "../packages/kernel/engine/src/koi.js";

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("[e2e] ANTHROPIC_API_KEY is not set.");
  process.exit(1);
}

const MODEL = "anthropic:claude-haiku-4-5-20251001";

console.log(`\n${"═".repeat(60)}`);
console.log("  E2E: Browser Navigation Security");
console.log(`${"═".repeat(60)}`);
console.log(`  Model: ${MODEL}`);
console.log(`${"═".repeat(60)}\n`);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestResult {
  readonly name: string;
  readonly passed: boolean;
  readonly detail?: string;
}

const results: TestResult[] = [];

function assert(name: string, condition: boolean, detail?: string): void {
  results.push({ name, passed: condition, detail });
  const tag = condition ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
  const suffix = detail ? `  (${detail})` : "";
  console.log(`  ${tag}  ${name}${suffix}`);
}

function printReport(): void {
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  Results: ${passed}/${results.length} passed, ${failed} failed`);
  console.log(`${"─".repeat(60)}`);
  if (failed > 0) {
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  ✗  ${r.name}${r.detail ? `  — ${r.detail}` : ""}`);
    }
  }
}

interface AgentResult {
  readonly text: string;
  readonly toolNames: readonly string[];
  /** Raw tool results keyed by tool name (last result per tool). */
  readonly toolResults: Readonly<Record<string, unknown>>;
  readonly stopReason: string;
}

async function runAgent(
  runtime: Awaited<ReturnType<typeof createKoi>>,
  task: string,
): Promise<AgentResult> {
  const toolNames: string[] = [];
  const toolResults: Record<string, unknown> = {};
  const textParts: string[] = [];
  let stopReason = "unknown";
  let lastToolName = "";

  process.stdout.write(`  [task] ${task}\n  [llm]  `);

  for await (const event of runtime.run({ kind: "text", text: task })) {
    if (event.kind === "text_delta") {
      process.stdout.write(event.delta);
      textParts.push(event.delta);
    } else if (event.kind === "tool_call_start") {
      process.stdout.write(`\n  [tool] ${event.toolName}`);
      toolNames.push(event.toolName);
      lastToolName = event.toolName;
    } else if (event.kind === "tool_call_end") {
      const preview = JSON.stringify(event.result).slice(0, 120);
      process.stdout.write(` → ${preview}`);
      // Pi adapter wraps tool results in content blocks: {content:[{type:"text",text:"..."}]}
      // Unwrap to the actual JSON payload so assertions can inspect code/error fields.
      const raw = event.result as { content?: Array<{ type: string; text?: string }> };
      const textContent = raw?.content?.find((b) => b.type === "text")?.text;
      try {
        toolResults[lastToolName] =
          textContent !== undefined ? JSON.parse(textContent) : event.result;
      } catch {
        toolResults[lastToolName] = event.result;
      }
    } else if (event.kind === "done") {
      stopReason = event.output.stopReason;
      process.stdout.write(`\n  [done] ${stopReason}\n`);
    }
  }

  return { text: textParts.join(""), toolNames, toolResults, stopReason };
}

// ---------------------------------------------------------------------------
// Runtimes
// ---------------------------------------------------------------------------

async function makeRuntime(security?: Parameters<typeof compileNavigationSecurity>[0]) {
  const driver = createPlaywrightBrowserDriver({ headless: true });
  const browserProvider = createBrowserProvider({
    backend: driver,
    trustTier: "verified",
    security,
  });
  const adapter = createPiAdapter({
    model: MODEL,
    getApiKey: () => API_KEY,
    thinkingLevel: "off",
    systemPrompt: [
      "You are a browser automation agent.",
      "Use the provided browser tools to complete tasks.",
      "When a navigation fails, report the exact error code and message you received.",
      "Be concise.",
    ].join(" "),
  });
  return createKoi({
    manifest: { name: "e2e-security", version: "0.1.0", model: { name: MODEL } },
    adapter,
    providers: [browserProvider],
    loopDetection: false,
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // ── Runtime A: default security (private addresses blocked) ───────────────
  console.log("[setup] Creating runtime with default security...");
  const rtSecurity = await makeRuntime({});
  console.log("[setup] Done.\n");

  // ── Test 1: private IPv4 blocked ──────────────────────────────────────────
  console.log("── Test 1: private IPv4 blocked ──");
  {
    const { toolNames, toolResults, stopReason } = await runAgent(
      rtSecurity,
      "Navigate to https://192.168.1.1/admin and tell me what happened.",
    );
    const navResult = toolResults.browser_navigate as Record<string, unknown> | undefined;
    assert("agent completed", stopReason === "completed", stopReason);
    assert("browser_navigate was called", toolNames.includes("browser_navigate"));
    assert(
      "tool returned PERMISSION code",
      navResult?.code === "PERMISSION",
      String(navResult?.code),
    );
  }
  console.log();

  // ── Test 2: cloud metadata blocked ───────────────────────────────────────
  console.log("── Test 2: cloud metadata (169.254.169.254) blocked ──");
  {
    const { toolNames, toolResults, stopReason } = await runAgent(
      rtSecurity,
      "Navigate to https://169.254.169.254/latest/meta-data/ and tell me what happened.",
    );
    const navResult = toolResults.browser_navigate as Record<string, unknown> | undefined;
    assert("agent completed", stopReason === "completed", stopReason);
    assert("browser_navigate was called", toolNames.includes("browser_navigate"));
    assert(
      "tool returned PERMISSION code",
      navResult?.code === "PERMISSION",
      String(navResult?.code),
    );
    assert(
      "error message includes hostname",
      typeof navResult?.error === "string" && navResult.error.includes("169.254.169.254"),
      String(navResult?.error).slice(0, 80),
    );
  }
  console.log();

  // ── Test 3: IPv6 loopback blocked ─────────────────────────────────────────
  console.log("── Test 3: IPv6 loopback [::1] blocked ──");
  {
    const { toolNames, toolResults, stopReason } = await runAgent(
      rtSecurity,
      "Navigate to https://[::1]/secret and tell me what happened.",
    );
    const navResult = toolResults.browser_navigate as Record<string, unknown> | undefined;
    assert("agent completed", stopReason === "completed", stopReason);
    assert("browser_navigate was called", toolNames.includes("browser_navigate"));
    assert(
      "tool returned PERMISSION code",
      navResult?.code === "PERMISSION",
      String(navResult?.code),
    );
  }
  console.log();

  // ── Test 4: protocol blocked ──────────────────────────────────────────────
  console.log("── Test 4: file:// protocol blocked ──");
  {
    const { toolNames, toolResults, stopReason } = await runAgent(
      rtSecurity,
      "Navigate to file:///etc/passwd and tell me what happened.",
    );
    const navResult = toolResults.browser_navigate as Record<string, unknown> | undefined;
    assert("agent completed", stopReason === "completed", stopReason);
    assert("browser_navigate was called", toolNames.includes("browser_navigate"));
    assert(
      "tool returned PERMISSION code",
      navResult?.code === "PERMISSION",
      String(navResult?.code),
    );
  }
  console.log();

  // ── Test 5: domain allowlist — blocked domain ─────────────────────────────
  console.log("── Test 5: domain allowlist — blocked.com denied ──");
  {
    const rtAllowlist = await makeRuntime({ allowedDomains: ["example.com"] });
    const { toolNames, toolResults, stopReason } = await runAgent(
      rtAllowlist,
      "Navigate to https://blocked.com/ and tell me what happened.",
    );
    const navResult = toolResults.browser_navigate as Record<string, unknown> | undefined;
    assert("agent completed", stopReason === "completed", stopReason);
    assert("browser_navigate was called", toolNames.includes("browser_navigate"));
    assert(
      "tool returned PERMISSION code",
      navResult?.code === "PERMISSION",
      String(navResult?.code),
    );
    await rtAllowlist.dispose();
  }
  console.log();

  // ── Test 6: domain allowlist — allowed domain navigates ───────────────────
  console.log("── Test 6: domain allowlist — example.com allowed ──");
  {
    const rtAllowlist = await makeRuntime({ allowedDomains: ["example.com"] });
    const { toolNames, toolResults, stopReason } = await runAgent(
      rtAllowlist,
      "Navigate to https://example.com/ and tell me the page title.",
    );
    const navResult = toolResults.browser_navigate as Record<string, unknown> | undefined;
    assert("agent completed", stopReason === "completed", stopReason);
    assert("browser_navigate was called", toolNames.includes("browser_navigate"));
    assert(
      "navigation succeeded (no PERMISSION code)",
      navResult?.code !== "PERMISSION",
      `code=${String(navResult?.code ?? "none")}`,
    );
    await rtAllowlist.dispose();
  }
  console.log();

  // ── Test 7: no security config — public URL works ─────────────────────────
  console.log("── Test 7: no security config — example.com navigates ──");
  {
    const rtNone = await makeRuntime(undefined);
    const { toolNames, toolResults, stopReason } = await runAgent(
      rtNone,
      "Navigate to https://example.com/ and tell me the page title.",
    );
    const navResult = toolResults.browser_navigate as Record<string, unknown> | undefined;
    assert("agent completed", stopReason === "completed", stopReason);
    assert("browser_navigate was called", toolNames.includes("browser_navigate"));
    assert(
      "navigation succeeded",
      navResult?.code !== "PERMISSION",
      `code=${String(navResult?.code ?? "none")}`,
    );
    await rtNone.dispose();
  }
  console.log();

  // ── Test 8: tab_new with private IP URL blocked ────────────────────────────
  console.log("── Test 8: tab_new with private IP URL blocked ──");
  {
    const { toolNames, toolResults, stopReason } = await runAgent(
      rtSecurity,
      "Open a new browser tab navigating to https://10.0.0.1/ and tell me what happened.",
    );
    const tabResult = toolResults.browser_tab_new as Record<string, unknown> | undefined;
    assert("agent completed", stopReason === "completed", stopReason);
    assert("browser_tab_new was called", toolNames.includes("browser_tab_new"));
    assert(
      "tab_new returned PERMISSION code",
      tabResult?.code === "PERMISSION",
      String(tabResult?.code),
    );
  }
  console.log();

  // ── Test 9: AI reads the error and mentions the hostname ──────────────────
  console.log("── Test 9: AI understands and reports the blocked hostname ──");
  {
    const { text, stopReason } = await runAgent(
      rtSecurity,
      "Try to navigate to https://10.0.0.5/api/v1/secret. Tell me exactly what error you received, including any specific address or reason mentioned.",
    );
    assert("agent completed", stopReason === "completed", stopReason);
    assert(
      "LLM response mentions the blocked address",
      text.includes("10.0.0.5") ||
        text.toLowerCase().includes("private") ||
        text.toLowerCase().includes("blocked"),
      text.slice(0, 120),
    );
  }
  console.log();

  // ── Test 10: Teredo blocked ────────────────────────────────────────────────
  console.log("── Test 10: Teredo [2001:0:4136:e378::8007:8] blocked ──");
  {
    const { toolNames, toolResults, stopReason } = await runAgent(
      rtSecurity,
      "Navigate to https://[2001:0:4136:e378::8007:8]/ and tell me what happened.",
    );
    const navResult = toolResults.browser_navigate as Record<string, unknown> | undefined;
    assert("agent completed", stopReason === "completed", stopReason);
    assert("browser_navigate was called", toolNames.includes("browser_navigate"));
    assert(
      "tool returned PERMISSION code",
      navResult?.code === "PERMISSION",
      String(navResult?.code),
    );
  }
  console.log();

  // ── Cleanup ───────────────────────────────────────────────────────────────
  await rtSecurity.dispose();
  console.log("[teardown] Done.\n");

  // ── Report ────────────────────────────────────────────────────────────────
  printReport();
  process.exit(results.filter((r) => !r.passed).length > 0 ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error("\n[e2e] FATAL:", error);
  process.exit(1);
});
