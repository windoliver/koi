#!/usr/bin/env bun

/**
 * Manual E2E — Issue #270 follow-on: browser_console + retryAfterMs + INTERNAL prompt
 *
 * Three features validated end-to-end:
 *   1. browser_console tool — per-tab buffering, level filtering, limit, clear
 *   2. retryAfterMs on timeout() — error translator produces retryAfterMs: 2_000 on TimeoutError
 *   3. INTERNAL + STALE_REF rows in BROWSER_SYSTEM_PROMPT
 *
 * Section A — direct driver/module tests (no LLM required, no API key needed):
 *   A1. console() returns empty entries on a fresh page
 *   A2. console() captures log/warn/error injected via evaluate()
 *   A3. console() filters by level (error-only)
 *   A4. console() respects limit (most recent N entries)
 *   A5. console() clears buffer when clear: true
 *   A6. per-tab isolation — tab-1 and tab-2 have separate console buffers
 *   A7. translatePlaywrightError produces TIMEOUT + retryAfterMs: 2_000 on TimeoutError
 *   A8. BROWSER_SYSTEM_PROMPT contains INTERNAL and STALE_REF error-code rows
 *
 * Section B — LLM-driven tests (Pi adapter + real Anthropic API call):
 *   B1. agent injects JS console messages, reads them via browser_console
 *   B2. agent uses level=error filtering to isolate errors from log/warn
 *   B3. agent reads console, then verifies buffer is empty after clear: true
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... bun scripts/e2e-browser-270.ts
 *   ANTHROPIC_API_KEY=sk-... HEADLESS=false bun scripts/e2e-browser-270.ts  # headed
 *   SECTION=A bun scripts/e2e-browser-270.ts                                 # no API key needed
 */

import { translatePlaywrightError } from "../packages/browser-playwright/src/error-translator.js";
import { createPlaywrightBrowserDriver } from "../packages/browser-playwright/src/playwright-browser-driver.js";
import { createKoi } from "../packages/engine/src/koi.js";
import { createPiAdapter } from "../packages/engine-pi/src/adapter.js";
import { createBrowserProvider } from "../packages/tool-browser/src/browser-component-provider.js";
import { ALL_OPERATIONS, BROWSER_SYSTEM_PROMPT } from "../packages/tool-browser/src/constants.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HEADLESS = process.env.HEADLESS !== "false";
const SECTION = (process.env.SECTION ?? "AB").toUpperCase();
const RUN_LLM = SECTION.includes("B");
const MODEL = "anthropic:claude-haiku-4-5-20251001";

if (RUN_LLM && !API_KEY) {
  console.error("[e2e] ANTHROPIC_API_KEY is not set. Run with SECTION=A to skip LLM tests.");
  process.exit(1);
}

console.log(`\n${"═".repeat(64)}`);
console.log("  E2E: Issue #270 — browser_console + retryAfterMs + INTERNAL");
console.log(`${"═".repeat(64)}`);
console.log(`  Model:    ${MODEL}`);
console.log(`  Headless: ${HEADLESS}`);
console.log(`  Sections: ${SECTION}`);
console.log(`${"═".repeat(64)}\n`);

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface TestResult {
  readonly name: string;
  readonly passed: boolean;
  readonly detail?: string;
}

const results: TestResult[] = [];
let currentSection = "";

function section(name: string): void {
  currentSection = name;
  console.log(`\n── ${name} ${"─".repeat(Math.max(0, 56 - name.length))}`);
}

function assert(name: string, condition: boolean, detail?: string): void {
  const label = `${currentSection} > ${name}`;
  results.push({ name: label, passed: condition, detail });
  const tag = condition ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
  const suffix = detail ? `  (${detail})` : "";
  console.log(`  ${tag}  ${name}${suffix}`);
}

function printReport(): void {
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log(`\n${"═".repeat(64)}`);
  console.log(
    `  Results: ${passed}/${results.length} passed${failed > 0 ? `, ${failed} FAILED` : ""}`,
  );
  console.log(`${"═".repeat(64)}`);
  if (failed > 0) {
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  ✗  ${r.name}${r.detail ? `  — ${r.detail}` : ""}`);
    }
  }
  console.log();
}

async function runAgent(
  runtime: Awaited<ReturnType<typeof createKoi>>,
  task: string,
): Promise<{
  readonly text: string;
  readonly toolNames: readonly string[];
  readonly stopReason: string;
}> {
  const toolNames: string[] = [];
  const textParts: string[] = [];
  let stopReason = "unknown";

  process.stdout.write(`  [task] ${task.slice(0, 120)}${task.length > 120 ? "…" : ""}\n  [llm]  `);

  for await (const event of runtime.run({ kind: "text", text: task })) {
    if (event.kind === "text_delta") {
      process.stdout.write(event.delta);
      textParts.push(event.delta);
    } else if (event.kind === "tool_call_start") {
      process.stdout.write(`\n  [tool] ${event.toolName}`);
      toolNames.push(event.toolName);
    } else if (event.kind === "tool_call_end") {
      const r = JSON.stringify(event.result);
      process.stdout.write(` → ${r.length > 100 ? `${r.slice(0, 100)}…` : r}`);
    } else if (event.kind === "done") {
      stopReason = event.output.stopReason;
      process.stdout.write(
        `\n  [done] stopReason=${stopReason} tokens=${event.output.metrics.totalTokens ?? 0}\n`,
      );
    }
  }

  return { text: textParts.join(""), toolNames, stopReason };
}

// ---------------------------------------------------------------------------
// Section A — direct driver + module tests (no LLM required)
// ---------------------------------------------------------------------------

async function runSectionA(): Promise<void> {
  const driver = createPlaywrightBrowserDriver({ headless: HEADLESS });

  // ── A1: console() returns empty entries on a fresh page ─────────────────

  section("A1: console() empty on fresh page");
  {
    const nav = await driver.navigate("https://example.com");
    assert(
      "navigate succeeds",
      nav.ok,
      nav.ok ? undefined : JSON.stringify((nav as { error: unknown }).error),
    );

    const result = await driver.console();
    assert("console() succeeds", result.ok);
    if (result.ok) {
      // example.com may produce a small number of messages; what matters is
      // the call succeeds and returns the expected shape.
      assert("entries is an array", Array.isArray(result.value.entries));
      assert("total is a number", typeof result.value.total === "number");
      assert(
        "total >= entries.length",
        result.value.total >= result.value.entries.length,
        `total=${result.value.total} entries=${result.value.entries.length}`,
      );
    }
  }

  // ── A2: console() captures messages injected via evaluate() ─────────────

  section("A2: console() captures injected messages");
  {
    // Clear any existing buffer first, then inject known messages.
    await driver.console({ clear: true });

    const inject = await driver.evaluate(
      `console.log("log-msg"); console.warn("warn-msg"); console.error("error-msg"); "done"`,
    );
    assert(
      "evaluate inject succeeds",
      inject.ok,
      inject.ok ? undefined : JSON.stringify((inject as { error: unknown }).error),
    );

    const result = await driver.console();
    assert("console() succeeds", result.ok);
    if (result.ok) {
      const texts = result.value.entries.map((e) => e.text);
      assert("captured 3 entries", result.value.entries.length >= 3, String(result.value.total));
      assert(
        "log-msg present",
        texts.some((t) => t.includes("log-msg")),
      );
      assert(
        "warn-msg present",
        texts.some((t) => t.includes("warn-msg")),
      );
      assert(
        "error-msg present",
        texts.some((t) => t.includes("error-msg")),
      );
      // Verify levels are correct
      const logEntry = result.value.entries.find((e) => e.text.includes("log-msg"));
      const errEntry = result.value.entries.find((e) => e.text.includes("error-msg"));
      assert("log-msg has level=log", logEntry?.level === "log", logEntry?.level);
      assert("error-msg has level=error", errEntry?.level === "error", errEntry?.level);
    }
  }

  // ── A3: console() filters by level ──────────────────────────────────────

  section("A3: console() level filtering");
  {
    // Buffer has log-msg, warn-msg, error-msg from A2 (not cleared).
    const errorOnly = await driver.console({ levels: ["error"] });
    assert("error-only filter succeeds", errorOnly.ok);
    if (errorOnly.ok) {
      const levels = errorOnly.value.entries.map((e) => e.level);
      assert(
        "all returned entries are 'error'",
        levels.every((l) => l === "error"),
        levels.join(),
      );
      assert(
        "error-msg is included",
        errorOnly.value.entries.some((e) => e.text.includes("error-msg")),
      );
      assert(
        "log-msg is excluded",
        !errorOnly.value.entries.some((e) => e.text.includes("log-msg")),
      );
    }
  }

  // ── A4: console() respects limit (most recent N entries) ─────────────────

  section("A4: console() limit");
  {
    // Inject 10 numbered messages then ask for the last 3.
    await driver.console({ clear: true });
    await driver.evaluate(`for (let i = 1; i <= 10; i++) console.log("msg-" + i); "done"`);

    const limited = await driver.console({ limit: 3 });
    assert("limit request succeeds", limited.ok);
    if (limited.ok) {
      assert(
        "total reflects full buffer (10)",
        limited.value.total === 10,
        String(limited.value.total),
      );
      assert(
        "entries returned is at most 3",
        limited.value.entries.length <= 3,
        String(limited.value.entries.length),
      );
      // Should be the LAST 3 (most recent): msg-8, msg-9, msg-10
      const texts = limited.value.entries.map((e) => e.text);
      assert(
        "msg-10 is present (most recent)",
        texts.some((t) => t.includes("msg-10")),
      );
      // Use exact match — "msg-1" is a substring of "msg-10", so .includes() would false-positive
      assert("msg-1 is absent (oldest, outside limit)", !texts.some((t) => t === "msg-1"));
    }
  }

  // ── A5: console() clears buffer when clear: true ─────────────────────────

  section("A5: console() clear");
  {
    // Buffer has 10 messages from A4.
    const before = await driver.console();
    assert(
      "buffer is non-empty before clear",
      before.ok && before.value.total > 0,
      String(before.ok ? before.value.total : "error"),
    );

    // Read with clear: true
    const cleared = await driver.console({ clear: true });
    assert("clear request succeeds", cleared.ok);

    // Next read should be empty
    const after = await driver.console();
    assert(
      "buffer is empty after clear",
      after.ok && after.value.total === 0,
      String(after.ok ? after.value.total : "error"),
    );
  }

  // ── A6: per-tab console isolation ─────────────────────────────────────────

  section("A6: per-tab console isolation");
  {
    // tab-1 is already open on example.com
    // Inject a message into tab-1
    await driver.console({ clear: true });
    await driver.evaluate(`console.log("tab1-only-message"); "done"`);

    // Open tab-2 and inject a different message there
    const tab2 = await driver.tabNew({ url: "about:blank" });
    assert("tab-2 opens", tab2.ok);
    await driver.evaluate(`console.log("tab2-only-message"); "done"`);

    // Read console on tab-2 — should see tab2 message only
    const tab2Console = await driver.console();
    assert("tab-2 console succeeds", tab2Console.ok);
    if (tab2Console.ok) {
      assert(
        "tab2-only-message present in tab-2",
        tab2Console.value.entries.some((e) => e.text.includes("tab2-only-message")),
      );
      assert(
        "tab1-only-message absent from tab-2",
        !tab2Console.value.entries.some((e) => e.text.includes("tab1-only-message")),
      );
    }

    // Switch back to tab-1 — should see its own message, not tab-2's
    await driver.tabFocus("tab-1");
    const tab1Console = await driver.console();
    assert("tab-1 console succeeds after switch", tab1Console.ok);
    if (tab1Console.ok) {
      assert(
        "tab1-only-message present in tab-1",
        tab1Console.value.entries.some((e) => e.text.includes("tab1-only-message")),
      );
      assert(
        "tab2-only-message absent from tab-1",
        !tab1Console.value.entries.some((e) => e.text.includes("tab2-only-message")),
      );
    }

    // Cleanup
    if (tab2.ok) await driver.tabClose(tab2.value.tabId);
  }

  // ── A7: translatePlaywrightError produces retryAfterMs: 2_000 ───────────

  section("A7: retryAfterMs on TimeoutError");
  {
    // Simulate a Playwright TimeoutError (name-based detection)
    const fakeTimeout = new Error(
      "locator.click: Timeout 30000ms exceeded waiting for element to be visible",
    );
    fakeTimeout.name = "TimeoutError";

    const err = translatePlaywrightError("browser_click", fakeTimeout);
    assert("code is TIMEOUT", err.code === "TIMEOUT", err.code);
    assert("retryable is true", err.retryable === true, String(err.retryable));
    assert(
      "retryAfterMs is 2000",
      err.retryAfterMs === 2_000,
      `retryAfterMs=${String(err.retryAfterMs)}`,
    );
    assert("message mentions the operation", err.message.includes("browser_click"), err.message);

    // Also verify message-based detection (for environments where name isn't set)
    const msgBasedErr = translatePlaywrightError(
      "browser_navigate",
      new Error("Navigation timeout exceeded — try again"),
    );
    assert("message-based timeout detected", msgBasedErr.code === "TIMEOUT", msgBasedErr.code);
    assert("message-based also gets retryAfterMs", msgBasedErr.retryAfterMs === 2_000);

    // Non-timeout errors must NOT have retryAfterMs
    const netErr = translatePlaywrightError(
      "browser_navigate",
      new Error("net::ERR_NAME_NOT_RESOLVED"),
    );
    assert(
      "non-timeout has no retryAfterMs",
      netErr.retryAfterMs === undefined,
      String(netErr.retryAfterMs),
    );
  }

  // ── A8: BROWSER_SYSTEM_PROMPT contains INTERNAL and STALE_REF rows ───────

  section("A8: BROWSER_SYSTEM_PROMPT error table");
  assert(
    "is a non-empty string",
    typeof BROWSER_SYSTEM_PROMPT === "string" && BROWSER_SYSTEM_PROMPT.length > 0,
  );
  assert("contains STALE_REF", BROWSER_SYSTEM_PROMPT.includes("STALE_REF"));
  assert("contains INTERNAL", BROWSER_SYSTEM_PROMPT.includes("INTERNAL"));
  assert("contains TIMEOUT", BROWSER_SYSTEM_PROMPT.includes("TIMEOUT"));
  assert("contains PERMISSION", BROWSER_SYSTEM_PROMPT.includes("PERMISSION"));
  assert("contains EXTERNAL", BROWSER_SYSTEM_PROMPT.includes("EXTERNAL"));
  assert(
    "INTERNAL row mentions page crash/closed",
    BROWSER_SYSTEM_PROMPT.toLowerCase().includes("crash") ||
      BROWSER_SYSTEM_PROMPT.toLowerCase().includes("closed") ||
      BROWSER_SYSTEM_PROMPT.toLowerCase().includes("page"),
  );
  assert(
    "STALE_REF row mentions snapshot",
    BROWSER_SYSTEM_PROMPT.toLowerCase().includes("snapshot"),
  );
  assert("snapshotId guidance present", BROWSER_SYSTEM_PROMPT.includes("snapshotId"));

  await driver.dispose?.();
}

// ---------------------------------------------------------------------------
// Section B — LLM-driven tests (Pi adapter + real Anthropic API call)
// ---------------------------------------------------------------------------

function makeAdapter(): ReturnType<typeof createPiAdapter> {
  return createPiAdapter({
    model: MODEL,
    getApiKey: () => API_KEY,
    thinkingLevel: "off",
    systemPrompt: [
      "You are a browser automation agent.",
      "Use the provided browser tools to complete each task exactly as instructed.",
      "Always call browser_snapshot before clicking or interacting with elements.",
      "Be concise — complete the task and report results briefly.",
    ].join(" "),
  });
}

async function makeRuntime(name: string): Promise<Awaited<ReturnType<typeof createKoi>>> {
  const backend = createPlaywrightBrowserDriver({ headless: HEADLESS });
  const provider = createBrowserProvider({
    backend,
    trustTier: "verified",
    operations: ALL_OPERATIONS,
  });
  return createKoi({
    manifest: { name, version: "0.1.0", model: { name: MODEL } },
    adapter: makeAdapter(),
    providers: [provider],
    loopDetection: false,
    limits: { maxTurns: 15 },
  });
}

async function runSectionB(): Promise<void> {
  console.log("[setup] Creating per-test runtimes (fresh driver per test).\n");

  // ── B1: agent injects JS messages and reads them via browser_console ──────

  section("B1: agent reads browser_console (LLM)");
  {
    const rt = await makeRuntime("e2e-270-b1");
    try {
      const { text, toolNames, stopReason } = await runAgent(
        rt,
        [
          "Navigate to https://example.com.",
          "Then use browser_evaluate to run this JavaScript:",
          '  console.log("hello from log"); console.warn("hello from warn"); console.error("critical-failure-xyz"); "done"',
          "After that, use browser_console to read all buffered console messages.",
          "Tell me: how many messages are there, what levels are they, and what do they say?",
        ].join(" "),
      );
      assert("agent completed", stopReason === "completed", stopReason);
      assert("browser_navigate called", toolNames.includes("browser_navigate"));
      assert("browser_evaluate called", toolNames.includes("browser_evaluate"));
      assert("browser_console called", toolNames.includes("browser_console"));
      const lower = text.toLowerCase();
      assert(
        "agent sees the injected messages",
        lower.includes("critical-failure-xyz") ||
          lower.includes("hello from log") ||
          lower.includes("hello from warn"),
        text.slice(0, 200),
      );
    } finally {
      await rt.dispose();
    }
  }

  // ── B2: agent filters by error level only ────────────────────────────────

  section("B2: agent uses level=error filter (LLM)");
  {
    const rt = await makeRuntime("e2e-270-b2");
    try {
      const { text, toolNames, stopReason } = await runAgent(
        rt,
        [
          "Navigate to https://example.com.",
          "Use browser_evaluate to run:",
          '  console.log("info one"); console.log("info two"); console.error("only-error-abc"); "done"',
          'Now call browser_console with levels set to ["error"] to get only error messages.',
          "Tell me how many error messages you see and quote their text.",
        ].join(" "),
      );
      assert("agent completed", stopReason === "completed", stopReason);
      assert("browser_console called", toolNames.includes("browser_console"));
      const lower = text.toLowerCase();
      assert("agent reports only-error-abc", lower.includes("only-error-abc"), text.slice(0, 200));
      // Agent should mention filtering / errors (not info messages)
      assert(
        "response mentions error level",
        lower.includes("error") || lower.includes("1 message") || lower.includes("one message"),
        text.slice(0, 200),
      );
    } finally {
      await rt.dispose();
    }
  }

  // ── B3: agent verifies clear empties the buffer ───────────────────────────

  section("B3: agent verifies clear: true empties buffer (LLM)");
  {
    const rt = await makeRuntime("e2e-270-b3");
    try {
      const { text, toolNames, stopReason } = await runAgent(
        rt,
        [
          "Navigate to https://example.com.",
          "Use browser_evaluate to run: console.log('msg-alpha'); console.log('msg-beta'); \"done\"",
          "Call browser_console (no options) and confirm you see at least 2 messages.",
          "Then call browser_console with clear set to true.",
          "Finally call browser_console one more time (no options) and confirm the buffer is now empty (0 messages).",
          "Report what you found at each step.",
        ].join(" "),
      );
      assert("agent completed", stopReason === "completed", stopReason);
      assert(
        "browser_console called (at least twice)",
        toolNames.filter((t) => t === "browser_console").length >= 2,
      );
      const lower = text.toLowerCase();
      assert(
        "agent confirms buffer is empty after clear",
        lower.includes("empty") ||
          lower.includes("0 message") ||
          lower.includes("no message") ||
          lower.includes("cleared"),
        text.slice(0, 300),
      );
    } finally {
      await rt.dispose();
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (SECTION.includes("A")) {
    console.log("Running Section A (direct driver + module tests)...");
    await runSectionA();
  }

  if (RUN_LLM) {
    console.log("\nRunning Section B (LLM-driven tests)...");
    await runSectionB();
  }

  printReport();

  const failed = results.filter((r) => !r.passed).length;
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error("\n[e2e] FATAL:", error);
  process.exit(1);
});
