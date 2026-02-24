#!/usr/bin/env bun

/**
 * Manual E2E: Pi agent + browser tools against a real Playwright browser + real LLM call.
 *
 * Validates the full stack end-to-end:
 *   createPlaywrightBrowserDriver → createBrowserProvider → createKoi (Pi adapter)
 *   → real Anthropic API call → agent uses browser tools → verify outcomes
 *
 * Tests (in order):
 *   1. navigate      — agent navigates to example.com
 *   2. snapshot      — agent calls browser_snapshot and sees the accessibility tree
 *   3. hover         — agent hovers over a link
 *   4. press         — agent presses Tab to advance focus
 *   5. screenshot    — agent takes a screenshot and returns image data
 *   6. tab_new       — agent opens a second tab
 *   7. tab_close     — agent closes the second tab
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... bun scripts/e2e-browser-agent.ts
 *   ANTHROPIC_API_KEY=sk-... HEADLESS=false bun scripts/e2e-browser-agent.ts  # headed
 */

import { createPlaywrightBrowserDriver } from "../packages/browser-playwright/src/playwright-browser-driver.js";
import { createKoi } from "../packages/engine/src/koi.js";
import { createPiAdapter } from "../packages/engine-pi/src/adapter.js";
import { createBrowserProvider } from "../packages/tool-browser/src/browser-component-provider.js";
import { OPERATIONS } from "../packages/tool-browser/src/constants.js";

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("[e2e] ANTHROPIC_API_KEY is not set.");
  process.exit(1);
}

const HEADLESS = process.env.HEADLESS !== "false";
const MODEL = "anthropic:claude-haiku-4-5-20251001"; // fast + cheap for E2E

console.log(`\n${"═".repeat(60)}`);
console.log("  E2E: Browser Agent (Pi + Playwright)");
console.log(`${"═".repeat(60)}`);
console.log(`  Model:    ${MODEL}`);
console.log(`  Headless: ${HEADLESS}`);
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

/** Run agent with a task, collect events, return text response + tool calls made. */
async function runAgent(
  runtime: Awaited<ReturnType<typeof createKoi>>,
  task: string,
): Promise<{
  readonly text: string;
  readonly toolNames: readonly string[];
  readonly stopReason: string;
  readonly tokens: number;
}> {
  const toolNames: string[] = [];
  const textParts: string[] = [];
  let stopReason = "unknown";
  let tokens = 0;

  process.stdout.write(`  [task] ${task}\n  [llm]  `);

  for await (const event of runtime.run({ kind: "text", text: task })) {
    if (event.kind === "text_delta") {
      process.stdout.write(event.delta);
      textParts.push(event.delta);
    } else if (event.kind === "tool_call_start") {
      process.stdout.write(`\n  [tool] ${event.toolName}`);
      toolNames.push(event.toolName);
    } else if (event.kind === "tool_call_end") {
      const result = JSON.stringify(event.result);
      const preview = result.length > 80 ? `${result.slice(0, 80)}…` : result;
      process.stdout.write(` → ${preview}`);
    } else if (event.kind === "done") {
      stopReason = event.output.stopReason;
      tokens = event.output.metrics.totalTokens ?? 0;
      process.stdout.write(
        `\n  [done] stopReason=${stopReason} turns=${event.output.metrics.turns} tokens=${tokens}\n`,
      );
    }
  }

  return { text: textParts.join(""), toolNames, stopReason, tokens };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // ── Browser driver ────────────────────────────────────────────────────────
  console.log("[setup] Launching Playwright browser...");
  const driver = createPlaywrightBrowserDriver({ headless: HEADLESS });

  // ── Browser provider ──────────────────────────────────────────────────────
  const browserProvider = createBrowserProvider({
    backend: driver,
    trustTier: "verified",
    operations: OPERATIONS, // all 14 non-evaluate ops
  });

  // ── Pi adapter ────────────────────────────────────────────────────────────
  const adapter = createPiAdapter({
    model: MODEL,
    getApiKey: () => API_KEY,
    thinkingLevel: "off",
    systemPrompt: [
      "You are a browser automation agent.",
      "Use the provided browser tools to complete each task.",
      "Always call browser_snapshot before interacting with elements.",
      "Be concise — complete the task and report results briefly.",
    ].join(" "),
  });

  // ── Runtime ───────────────────────────────────────────────────────────────
  const runtime = await createKoi({
    manifest: {
      name: "e2e-browser-agent",
      version: "0.1.0",
      model: { name: MODEL },
    },
    adapter,
    providers: [browserProvider],
    loopDetection: false,
  });

  console.log("[setup] Agent assembled.\n");

  let totalTokens = 0;

  // ── Test 1: navigate + snapshot ───────────────────────────────────────────
  console.log("── Test 1: navigate + snapshot ──");
  {
    const { toolNames, stopReason, tokens, text } = await runAgent(
      runtime,
      "Navigate to https://example.com then take a snapshot and tell me the page title.",
    );
    totalTokens += tokens;
    assert("agent completed", stopReason === "completed", stopReason);
    assert("browser_navigate was called", toolNames.includes("browser_navigate"));
    assert("browser_snapshot was called", toolNames.includes("browser_snapshot"));
    assert("response mentions 'example'", text.toLowerCase().includes("example"));
  }
  console.log();

  // ── Test 2: hover ─────────────────────────────────────────────────────────
  console.log("── Test 2: hover ──");
  {
    const { toolNames, stopReason, tokens } = await runAgent(
      runtime,
      "Take a snapshot, then hover over the first link you see on the page.",
    );
    totalTokens += tokens;
    assert("agent completed", stopReason === "completed", stopReason);
    assert("browser_snapshot was called", toolNames.includes("browser_snapshot"));
    assert("browser_hover was called", toolNames.includes("browser_hover"));
  }
  console.log();

  // ── Test 3: press ─────────────────────────────────────────────────────────
  console.log("── Test 3: press ──");
  {
    const { toolNames, stopReason, tokens } = await runAgent(
      runtime,
      "Press the Tab key, then press it again. Report what you did.",
    );
    totalTokens += tokens;
    assert("agent completed", stopReason === "completed", stopReason);
    assert("browser_press was called", toolNames.includes("browser_press"));
  }
  console.log();

  // ── Test 4: screenshot ────────────────────────────────────────────────────
  console.log("── Test 4: screenshot ──");
  {
    const { toolNames, stopReason, tokens, text } = await runAgent(
      runtime,
      "Take a screenshot of the current page and tell me its dimensions.",
    );
    totalTokens += tokens;
    assert("agent completed", stopReason === "completed", stopReason);
    assert("browser_screenshot was called", toolNames.includes("browser_screenshot"));
    // Agent should see width/height in the result and mention numbers
    assert(
      "response mentions dimensions",
      /\d{3,4}/.test(text),
      "expected width/height digits in response",
    );
  }
  console.log();

  // ── Test 5: tab_new + tab_close ───────────────────────────────────────────
  console.log("── Test 5: tab_new + tab_close ──");
  {
    const { toolNames, stopReason, tokens } = await runAgent(
      runtime,
      "Open a new browser tab, then close it and return to the original tab.",
    );
    totalTokens += tokens;
    assert("agent completed", stopReason === "completed", stopReason);
    assert("browser_tab_new was called", toolNames.includes("browser_tab_new"));
    assert("browser_tab_close was called", toolNames.includes("browser_tab_close"));
  }
  console.log();

  // ── Test 6: press combo ───────────────────────────────────────────────────
  console.log("── Test 6: key combo (Control+a) ──");
  {
    const { toolNames, stopReason, tokens } = await runAgent(
      runtime,
      "Press Control+a to select all text on the page, then press Escape.",
    );
    totalTokens += tokens;
    assert("agent completed", stopReason === "completed", stopReason);
    assert("browser_press was called", toolNames.includes("browser_press"));
  }
  console.log();

  // ── Cleanup ───────────────────────────────────────────────────────────────
  await runtime.dispose();
  console.log(`[teardown] Browser closed. Total tokens used: ${totalTokens}\n`);

  // ── Report ────────────────────────────────────────────────────────────────
  printReport();

  const failed = results.filter((r) => !r.passed).length;
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error("\n[e2e] FATAL:", error);
  process.exit(1);
});
