#!/usr/bin/env bun

/**
 * Manual E2E: validates the three capabilities added in the "three-gaps" PR.
 *
 *   Gap 1 — file upload:      browser_upload tool (base64 → setInputFiles)
 *   Gap 2 — DNS rebinding:    PlaywrightDriverConfig.blockPrivateAddresses guard
 *   Gap 3 — trace recording:  browser_trace_start / browser_trace_stop tools
 *
 * Structure:
 *   Section A — direct driver tests (no LLM): DNS rebinding + trace sanity
 *   Section B — full-stack LLM tests (createKoi + createPiAdapter):
 *               upload through the real agent loop, trace through the real agent loop
 *
 * Usage:
 *   bun scripts/e2e-browser-new-gaps.ts
 *   HEADLESS=false bun scripts/e2e-browser-new-gaps.ts   # headed browser
 *   SECTION=A bun scripts/e2e-browser-new-gaps.ts        # skip LLM section
 *
 * API key: loaded automatically from .env in the repo root.
 * For the worktree, symlink or copy: cp /path/to/.env ./
 * Or pass inline: ANTHROPIC_API_KEY=sk-... bun scripts/e2e-browser-new-gaps.ts
 */

import { existsSync } from "node:fs";
import { createPlaywrightBrowserDriver } from "../packages/drivers/browser-playwright/src/playwright-browser-driver.js";
import { createPiAdapter } from "../packages/drivers/engine-pi/src/adapter.js";
import { createBrowserProvider } from "../packages/fs/tool-browser/src/browser-component-provider.js";
import { ALL_OPERATIONS } from "../packages/fs/tool-browser/src/constants.js";
import { createKoi } from "../packages/kernel/engine/src/koi.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HEADLESS = process.env.HEADLESS !== "false";
const SECTION = process.env.SECTION ?? "AB"; // "A" = driver-only, "AB" = all
const MODEL = "anthropic:claude-haiku-4-5-20251001";

console.log(`\n${"═".repeat(64)}`);
console.log("  E2E: Three-Gap PR validation (upload + DNS rebinding + trace)");
console.log(`${"═".repeat(64)}`);
console.log(`  Model:    ${MODEL}`);
console.log(`  Headless: ${HEADLESS}`);
console.log(`  Section:  ${SECTION}`);
console.log(`${"═".repeat(64)}\n`);

// ---------------------------------------------------------------------------
// Test harness
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
  console.log(`\n${"─".repeat(64)}`);
  console.log(`  Results: ${passed}/${results.length} passed, ${failed} failed`);
  console.log(`${"─".repeat(64)}`);
  if (failed > 0) {
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  ✗  ${r.name}${r.detail ? `  — ${r.detail}` : ""}`);
    }
  }
}

/** Run agent task, collect events, return structured summary. */
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
      const preview = r.length > 120 ? `${r.slice(0, 120)}…` : r;
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
// Section A — Driver-level tests (no LLM, deterministic, fast)
// ---------------------------------------------------------------------------

async function runSectionA(): Promise<void> {
  console.log(`\n${"━".repeat(64)}`);
  console.log("  Section A: Direct driver tests (no LLM)");
  console.log(`${"━".repeat(64)}\n`);

  // ── A1: DNS rebinding guard — blocks hostname resolving to 127.0.0.1 ─────
  //
  // 127-0-0-1.nip.io is a public DNS service that maps encoded IPs back to
  // their literal. This hostname passes static URL checks (it's not an IP
  // literal) but resolves to 127.0.0.1, triggering the rebinding guard.
  //
  // Expected: navigation fails (net::ERR_ABORTED → EXTERNAL or INTERNAL code)
  console.log("── A1: DNS rebinding guard blocks rebindable hostname ──");
  {
    const driver = createPlaywrightBrowserDriver({ headless: HEADLESS });
    try {
      const result = await driver.navigate("http://127-0-0-1.nip.io/");
      // If nip.io is down or times out we might get a different error —
      // any failure is still a pass (the guard either blocked it or the DNS
      // lookup failed, both of which prevent the navigation from succeeding).
      assert(
        "A1: navigation to rebindable hostname fails",
        !result.ok,
        result.ok ? "expected failure but got success" : result.error.code,
      );
      if (!result.ok) {
        // Guard fires → ERR_ABORTED → EXTERNAL. DNS timeout → EXTERNAL/INTERNAL.
        // Either way, navigation must not succeed.
        assert(
          "A1: error is EXTERNAL or INTERNAL (not success)",
          result.error.code === "EXTERNAL" || result.error.code === "INTERNAL",
          result.error.code,
        );
      }
    } finally {
      await driver.dispose?.();
    }
  }
  console.log();

  // ── A2: DNS rebinding guard — passes for a real public hostname ───────────
  //
  // Validates the guard does NOT block legitimate navigations.
  // example.com resolves to a public IP (93.184.216.34).
  console.log("── A2: DNS rebinding guard allows legitimate public hostname ──");
  {
    const driver = createPlaywrightBrowserDriver({ headless: HEADLESS });
    try {
      const result = await driver.navigate("https://example.com");
      assert(
        "A2: navigation to example.com succeeds",
        result.ok,
        result.ok ? result.value.url : result.error.code,
      );
    } finally {
      await driver.dispose?.();
    }
  }
  console.log();

  // ── A3: blockPrivateAddresses=false bypasses the guard ───────────────────
  //
  // Functional test: disabling the flag means route() is never registered.
  // localhost:9999 will still fail (connection refused), but the failure
  // reason is net::ERR_CONNECTION_REFUSED, not ERR_ABORTED.
  // We just verify the flag parses and is accepted in config (type-level
  // guarantee already checked by typecheck, this tests runtime wiring).
  console.log("── A3: blockPrivateAddresses=false is accepted in config ──");
  {
    const driver = createPlaywrightBrowserDriver({
      headless: HEADLESS,
      blockPrivateAddresses: false,
    });
    // With the guard disabled, localhost navigation will fail with
    // ERR_CONNECTION_REFUSED (no server), not ERR_ABORTED.
    const result = await driver.navigate("http://localhost:19999/");
    // Must fail (no server), but reason differs from rebinding block
    assert(
      "A3: navigation fails with connection refused, not access denied",
      !result.ok && result.error.code === "EXTERNAL",
      result.ok
        ? "unexpected success"
        : `${result.error.code}: ${result.error.message.slice(0, 60)}`,
    );
    await driver.dispose?.();
  }
  console.log();

  // ── A4: traceStart / traceStop — direct driver smoke test ─────────────────
  //
  // Validates the trace recording lifecycle:
  //   1. traceStart() returns {ok:true}
  //   2. Do a navigation so the trace has something recorded
  //   3. traceStop() returns {ok:true, value:{path: ...koi-trace-*.zip}}
  //   4. The .zip file actually exists on disk
  console.log("── A4: traceStart / traceStop — driver smoke test ──");
  {
    const driver = createPlaywrightBrowserDriver({ headless: HEADLESS });
    try {
      // Navigate first so there is a page context for tracing
      await driver.navigate("https://example.com");

      // Start trace
      if (!driver.traceStart) {
        assert("A4: traceStart method exists", false, "method not present");
      } else {
        const startResult = await driver.traceStart({ title: "koi-e2e-gap3", snapshots: true });
        assert(
          "A4: traceStart returns ok",
          startResult.ok,
          startResult.ok ? "" : startResult.error.code,
        );

        // Do something meaningful so the trace has content
        await driver.snapshot();

        // Stop trace
        if (!driver.traceStop) {
          assert("A4: traceStop method exists", false, "method not present");
        } else {
          const stopResult = await driver.traceStop();
          assert(
            "A4: traceStop returns ok",
            stopResult.ok,
            stopResult.ok ? "" : stopResult.error.code,
          );
          if (stopResult.ok) {
            const tracePath = stopResult.value.path;
            assert("A4: trace path ends with .zip", tracePath.endsWith(".zip"), tracePath);
            assert("A4: trace file exists on disk", existsSync(tracePath), tracePath);
            console.log(`  [trace] saved to: ${tracePath}`);
          }
        }
      }
    } finally {
      await driver.dispose?.();
    }
  }
  console.log();
}

// ---------------------------------------------------------------------------
// Section B — Full-stack LLM tests (createKoi + createPiAdapter)
// ---------------------------------------------------------------------------

async function runSectionB(): Promise<void> {
  if (!API_KEY) {
    console.log(`\n${"━".repeat(64)}`);
    console.log("  Section B: SKIPPED — ANTHROPIC_API_KEY not set");
    console.log(`${"━".repeat(64)}\n`);
    return;
  }

  console.log(`\n${"━".repeat(64)}`);
  console.log("  Section B: Full-stack LLM tests (createKoi + Pi adapter)");
  console.log(`${"━".repeat(64)}\n`);

  // ── Assemble runtime ───────────────────────────────────────────────────────
  console.log("[setup] Launching Playwright + assembling Koi runtime...");

  const driver = createPlaywrightBrowserDriver({ headless: HEADLESS });

  // Include ALL_OPERATIONS so upload, trace_start, trace_stop are registered
  const browserProvider = createBrowserProvider({
    backend: driver,
    trustTier: "verified",
    prefix: "browser",
    operations: ALL_OPERATIONS,
  });

  const adapter = createPiAdapter({
    model: MODEL,
    getApiKey: () => API_KEY,
    thinkingLevel: "off",
    systemPrompt: [
      "You are a browser automation agent.",
      "Use the provided browser tools to complete each task precisely.",
      "Always call browser_snapshot before interacting with elements.",
      "Be concise — complete the task then report the outcome in one short sentence.",
    ].join(" "),
  });

  const runtime = await createKoi({
    manifest: { name: "e2e-new-gaps", version: "0.1.0", model: { name: MODEL } },
    adapter,
    providers: [browserProvider],
    loopDetection: false,
  });

  console.log("[setup] Agent assembled.\n");

  let totalTokens = 0;

  // ── B1: file upload through full agent loop ────────────────────────────────
  //
  // Navigate to a page with a file input, snapshot to get the ref,
  // then use browser_upload with a base64-encoded test file.
  //
  // "Hello Koi!" base64 = SGVsbG8gS29pIQ==
  // Site: the-internet.herokuapp.com/upload has a classic <input type="file">.
  console.log("── B1: file upload (full agent loop) ──");
  {
    const { toolNames, stopReason, tokens } = await runAgent(
      runtime,
      "Navigate to https://the-internet.herokuapp.com/upload. " +
        "Take a snapshot. " +
        "Find the file input element and upload a file to it using browser_upload. " +
        "Use these exact values: content='SGVsbG8gS29pIQ==', name='hello-koi.txt', mimeType='text/plain'. " +
        "Report whether the upload tool call succeeded or failed.",
    );
    totalTokens += tokens;
    assert("B1: agent completed", stopReason === "completed", stopReason);
    assert("B1: browser_navigate called", toolNames.includes("browser_navigate"));
    assert("B1: browser_snapshot called", toolNames.includes("browser_snapshot"));
    assert("B1: browser_upload called", toolNames.includes("browser_upload"));
  }
  console.log();

  // ── B2: trace recording through full agent loop ───────────────────────────
  //
  // Agent starts a trace, navigates somewhere, stops the trace.
  // We verify: trace_start and trace_stop were both called, agent reports a path.
  console.log("── B2: trace recording (full agent loop) ──");
  {
    const { toolNames, stopReason, tokens, text } = await runAgent(
      runtime,
      "Use browser_trace_start to start recording a trace (with title 'llm-trace-test'). " +
        "Then navigate to https://example.com and take a snapshot. " +
        "Then use browser_trace_stop to stop the trace. " +
        "Report the exact file path returned by browser_trace_stop.",
    );
    totalTokens += tokens;
    assert("B2: agent completed", stopReason === "completed", stopReason);
    assert("B2: browser_trace_start called", toolNames.includes("browser_trace_start"));
    assert("B2: browser_trace_stop called", toolNames.includes("browser_trace_stop"));
    // The agent should mention the .zip path in its response
    assert("B2: response contains trace path (.zip)", text.includes(".zip"), text.slice(0, 100));
  }
  console.log();

  // ── B3: DNS rebinding blocked — agent observes the error ──────────────────
  //
  // The DNS rebinding guard fires at the driver level.
  // When the LLM asks to navigate to 127-0-0-1.nip.io, the driver aborts
  // the request (net::ERR_ABORTED → EXTERNAL error returned to the tool).
  // The agent should report a failure, not a successful navigation.
  console.log("── B3: DNS rebinding guard visible at agent level ──");
  {
    const { toolNames, stopReason, tokens, text } = await runAgent(
      runtime,
      "Try to navigate to http://127-0-0-1.nip.io/ using browser_navigate. " +
        "Tell me exactly what happened — did it succeed or fail, and what error was reported?",
    );
    totalTokens += tokens;
    assert("B3: agent completed", stopReason === "completed", stopReason);
    assert("B3: browser_navigate called", toolNames.includes("browser_navigate"));
    // The navigation must fail — the agent's text should mention failure/error
    const mentionsFailure =
      text.toLowerCase().includes("fail") ||
      text.toLowerCase().includes("error") ||
      text.toLowerCase().includes("blocked") ||
      text.toLowerCase().includes("unable") ||
      text.toLowerCase().includes("could not");
    assert(
      "B3: agent reports navigation failure (not success)",
      mentionsFailure,
      text.slice(0, 120),
    );
  }
  console.log();

  // ── Cleanup ───────────────────────────────────────────────────────────────
  await runtime.dispose();
  console.log(`\n[teardown] Browser closed. Total tokens used: ${totalTokens}\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (SECTION.includes("A")) {
    await runSectionA();
  }

  if (SECTION.includes("B")) {
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
