#!/usr/bin/env bun

/**
 * E2E: koi up + admin API — full autonomous spawn-delegation flow.
 *
 * Starts `koi up` with autonomous mode, sends messages via the admin API,
 * verifies harness status, and checks that spawn workers complete correctly.
 *
 * Flow:
 *   1. Write temp koi.yaml with autonomous enabled + OpenRouter model
 *   2. Start `koi up` as a subprocess
 *   3. Wait for admin API to become healthy
 *   4. Send user message via AG-UI chat endpoint
 *   5. Wait for harness to reach "completed" phase
 *   6. Verify task results via admin API
 *   7. Clean up
 *
 * Requires: OPENROUTER_API_KEY
 * Run: OPENROUTER_API_KEY=... bun scripts/e2e-koi-up-autonomous.ts
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

const API_KEY = process.env.OPENROUTER_API_KEY;
if (!API_KEY) {
  console.error("OPENROUTER_API_KEY not set");
  process.exit(1);
}

const ADMIN_PORT = 3100;
const ADMIN_URL = `http://localhost:${ADMIN_PORT}/admin/api`;
const AGUI_BASE = `http://localhost:${ADMIN_PORT}/admin/api/agents`;

// ---------------------------------------------------------------------------
// Test infra
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
function assert(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function step(msg: string): void {
  console.log(`\n\x1b[36m══ ${msg} ══\x1b[0m`);
}

// ---------------------------------------------------------------------------
// Admin API helpers
// ---------------------------------------------------------------------------

async function adminGet(path: string): Promise<unknown> {
  const res = await fetch(`${ADMIN_URL}${path}`);
  return res.json();
}

async function waitForHealthy(timeoutMs: number = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${ADMIN_URL}/health`);
      if (res.ok) {
        const json = (await res.json()) as { ok?: boolean; data?: { status?: string } };
        if (json.ok || json.data?.status === "ok") return true;
      }
    } catch {
      // Server not up yet
    }
    await Bun.sleep(500);
  }
  return false;
}

/** Wait for the AG-UI chat endpoint to be ready (returns 200 on agent list). */
async function waitForAgentReady(timeoutMs: number = 45_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${ADMIN_URL}/agents`);
      if (res.ok) {
        const json = (await res.json()) as { ok: boolean; data?: readonly unknown[] };
        if (json.ok && json.data !== undefined && json.data.length > 0) return true;
      }
    } catch {
      // Not ready
    }
    await Bun.sleep(1000);
  }
  return false;
}

/** Get the primary agent ID from the admin API. */
async function getPrimaryAgentId(): Promise<string> {
  const res = await fetch(`${ADMIN_URL}/agents`);
  const json = (await res.json()) as { ok: boolean; data?: readonly { agentId: string }[] };
  if (!json.ok || json.data === undefined || json.data.length === 0) {
    throw new Error("No agents found via admin API");
  }
  return json.data[0]?.agentId;
}

/** Send a message via AG-UI chat endpoint and collect the full response. */
async function sendMessage(message: string): Promise<{
  readonly events: string[];
  readonly text: string;
}> {
  const agentIdStr = await getPrimaryAgentId();
  const threadId = `thread-${Date.now().toString(36)}`;
  const runId = `run-${Date.now().toString(36)}`;

  // Retry up to 10 times — the chat handler may not be wired yet
  let res: Response | undefined;
  for (let attempt = 0; attempt < 10; attempt++) {
    res = await fetch(`${AGUI_BASE}/${agentIdStr}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId,
        runId,
        messages: [
          {
            id: `msg-${Date.now().toString(36)}`,
            role: "user",
            content: message,
          },
        ],
        tools: [],
        context: [],
      }),
    });
    if (res.ok || res.status !== 503) break;
    console.log(`  (chat 503, retry ${attempt + 1}/10...)`);
    await Bun.sleep(2000);
  }

  if (res === undefined || !res.ok) {
    throw new Error(
      `AG-UI request failed: ${res?.status ?? "no response"} ${res?.statusText ?? ""}`,
    );
  }

  // Parse SSE stream
  const body = await res.text();
  const events: string[] = [];
  const textParts: string[] = [];

  for (const line of body.split("\n")) {
    if (line.startsWith("data: ")) {
      const data = line.slice(6);
      events.push(data);
      try {
        const parsed = JSON.parse(data);
        if (parsed.type === "TEXT_MESSAGE_CONTENT" && typeof parsed.value === "string") {
          textParts.push(parsed.value);
        }
      } catch {
        // Non-JSON data line
      }
    }
  }

  return { events, text: textParts.join("") };
}

async function getHarnessStatus(): Promise<{
  readonly phase: string;
  readonly completedTaskCount: number;
  readonly pendingTaskCount: number;
  readonly taskBoard?: { readonly items: readonly unknown[]; readonly results: readonly unknown[] };
}> {
  const json = (await adminGet("/view/harness/status")) as {
    ok: boolean;
    data?: {
      phase: string;
      taskProgress?: { completed: number; total: number };
      metrics?: { completedTaskCount: number; pendingTaskCount: number };
      taskBoard?: { items: unknown[]; results: unknown[] };
    };
  };
  if (!json.ok || json.data === undefined) {
    return { phase: "unknown", completedTaskCount: 0, pendingTaskCount: 0 };
  }
  return {
    phase: json.data.phase,
    completedTaskCount:
      json.data.taskProgress?.completed ?? json.data.metrics?.completedTaskCount ?? 0,
    pendingTaskCount: json.data.metrics?.pendingTaskCount ?? 0,
    taskBoard: json.data.taskBoard as
      | { readonly items: readonly unknown[]; readonly results: readonly unknown[] }
      | undefined,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log("[e2e] koi up + admin API — autonomous spawn-delegation\n");

// Step 1: Create temp workspace with koi.yaml
step("Setup: create temp workspace");

const workDir = await mkdtemp(join(tmpdir(), "koi-e2e-"));
const koiYaml = `
name: "e2e-autonomous"
version: "0.0.1"
description: "E2E test for autonomous spawn delegation"

preset: local

model:
  name: "openrouter:anthropic/claude-3.5-haiku"

autonomous:
  enabled: true


# NOTE: demo preset fails with "model call failed: unknown error" due to
# governance middleware blocking model calls without proper Nexus auth setup.
# Using local preset with --nexus-url until governance+OpenRouter is debugged.
`.trim();

await writeFile(join(workDir, "koi.yaml"), koiYaml);
console.log(`  workspace: ${workDir}`);
console.log(`  koi.yaml written`);

// Step 2: Start koi up
step("Start: koi up");

const koiProcess = spawn(
  "bun",
  [
    "run",
    join(import.meta.dir, "..", "packages", "meta", "cli", "src", "bin.ts"),
    "up",
    "--manifest",
    join(workDir, "koi.yaml"),
    "--nexus-url",
    process.env.NEXUS_URL ?? "http://localhost:33320",
    "--verbose",
  ],
  {
    cwd: workDir,
    env: {
      ...process.env,
      OPENROUTER_API_KEY: API_KEY,
      NEXUS_API_KEY: process.env.NEXUS_API_KEY ?? "sk-qaJ8CryJvAtKpHGtIZe6KFOlHV44IhTlaVFXLVK0dbM",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

// Pipe stderr for debugging
koiProcess.stderr?.on("data", (chunk: Buffer) => {
  const text = chunk.toString().trim();
  if (text.length > 0) {
    for (const line of text.split("\n")) {
      process.stderr.write(`  [koi] ${line}\n`);
    }
  }
});

// Step 3: Wait for healthy
step("Wait: admin API healthy");

const healthy = await waitForHealthy(90_000);
assert("admin API is healthy", healthy);

if (!healthy) {
  console.error("Admin API did not become healthy. Aborting.");
  koiProcess.kill("SIGTERM");
  await rm(workDir, { recursive: true, force: true });
  process.exit(1);
}

// Step 3b: Wait for agent to be fully ready (chat handler wired)
step("Wait: agent ready");
const agentReady = await waitForAgentReady(45_000);
assert("agent is ready", agentReady);

if (!agentReady) {
  console.error("Agent did not become ready. Aborting.");
  koiProcess.kill("SIGTERM");
  await rm(workDir, { recursive: true, force: true });
  process.exit(1);
}

// Step 4: Send user message to create autonomous plan with spawn tasks
step("Session 1: Create spawn-delegation plan");

try {
  const response = await sendMessage(
    [
      "Use plan_autonomous to create a plan with 2 tasks.",
      'Both tasks should use delegation:"spawn" so they run as parallel workers.',
      "Tasks:",
      '  1. id:"haiku-ocean", description:"Write a haiku about the ocean. Return ONLY the haiku.", agentType:"poet"',
      '  2. id:"haiku-mountain", description:"Write a haiku about mountains. Return ONLY the haiku.", agentType:"poet"',
      "No dependencies between tasks.",
    ].join("\n"),
  );

  assert(
    "received response from agent",
    response.events.length > 0,
    `events=${response.events.length}`,
  );
  console.log(`  response text: ${response.text.slice(0, 200)}...`);
} catch (e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  assert("received response from agent", false, msg);
}

// Step 5: Wait for harness completion
step("Wait: harness completion");

const completionDeadline = Date.now() + 90_000;
while (Date.now() < completionDeadline) {
  const status = await getHarnessStatus();
  process.stdout.write(
    `\r  phase=${status.phase} done=${status.completedTaskCount} pending=${status.pendingTaskCount}  `,
  );
  if (status.phase === "completed" || status.phase === "failed") break;
  await Bun.sleep(2000);
}
console.log("");

// Step 6: Verify
step("Verify: harness status");

const finalStatus = await getHarnessStatus();
console.log(`  phase: ${finalStatus.phase}`);
console.log(`  completed: ${finalStatus.completedTaskCount}`);
console.log(`  pending: ${finalStatus.pendingTaskCount}`);

assert(
  "harness phase is completed",
  finalStatus.phase === "completed",
  `phase=${finalStatus.phase}`,
);
assert(
  "2 tasks completed",
  finalStatus.completedTaskCount === 2,
  `completed=${finalStatus.completedTaskCount}`,
);

// Check task results
if (finalStatus.taskBoard !== undefined) {
  const results = finalStatus.taskBoard.results as readonly { taskId: string; output: string }[];
  console.log(`\n  Task results (${results.length}):`);
  for (const r of results) {
    const preview = r.output.slice(0, 80).replace(/\n/g, " ");
    console.log(`    ${r.taskId}: ${preview}`);
  }
  assert("task results present", results.length >= 2, `results=${results.length}`);
}

// Step 7: Session 2 — copilot is responsive (not blocked)
step("Session 2: Copilot answers unrelated question");

try {
  const response2 = await sendMessage("What is 2 + 2? Reply with just the number.");
  assert("copilot responded", response2.events.length > 0);
  console.log(`  response: ${response2.text.slice(0, 50)}`);
} catch (e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  assert("copilot responded", false, msg);
}

// Cleanup
step("Cleanup");

koiProcess.kill("SIGTERM");
await new Promise<void>((resolve) => {
  koiProcess.on("close", resolve);
  setTimeout(resolve, 5000);
});
await rm(workDir, { recursive: true, force: true });
console.log("  koi process terminated, temp dir cleaned");

// Summary
console.log(`\n${"=".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(60)}`);
if (failed > 0) process.exit(1);
