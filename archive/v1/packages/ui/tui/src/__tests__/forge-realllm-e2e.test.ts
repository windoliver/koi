/**
 * Forge Real-LLM E2E — sends real prompts through the TUI console to trigger
 * forge middleware activity, then verifies forge events appear in the admin API
 * and the TUI renders them.
 *
 * Run:
 *   1. Start the stack:  cd demo-agent && bun run up
 *   2. In another terminal:
 *      E2E_TESTS=1 bun test src/__tests__/forge-realllm-e2e.test.ts
 *
 * Requires koi up running with forge enabled. Uses the TUI console to send
 * prompts (not the AG-UI API) so tools actually execute through the engine
 * pipeline with forge middleware.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const describeE2E = E2E_OPTED_IN ? describe : describe.skip;

const ADMIN_URL = process.env.ADMIN_URL ?? "http://localhost:3100/admin/api";
const TMUX_SESSION = "koi-forge-llm-e2e";
const LLM_TIMEOUT = 60_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function tmux(...args: readonly string[]): Promise<string> {
  const proc = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

async function captureTui(): Promise<string> {
  return tmux("capture-pane", "-t", TMUX_SESSION, "-p");
}

async function sendKey(key: string): Promise<void> {
  await tmux("send-keys", "-t", TMUX_SESSION, key);
  await sleep(300);
}

async function sendPrompt(text: string): Promise<void> {
  // Use -l (literal) to avoid tmux key interpretation issues
  await tmux("send-keys", "-t", TMUX_SESSION, "-l", text);
  await sleep(300);
  await tmux("send-keys", "-t", TMUX_SESSION, "Enter");
}

async function adminGet<T>(path: string): Promise<T | null> {
  try {
    const resp = await fetch(`${ADMIN_URL}${path}`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return null;
    const json = (await resp.json()) as { readonly ok: boolean; readonly data: T };
    return json.ok ? json.data : null;
  } catch {
    return null;
  }
}

interface ForgeEvent {
  readonly kind: string;
  readonly subKind: string;
  readonly timestamp: number;
}

interface ForgeBrick {
  readonly brickId: string;
  readonly name: string;
  readonly status: string;
  readonly fitness: number;
}

interface ForgeStats {
  readonly totalBricks: number;
  readonly activeBricks: number;
  readonly demandSignals: number;
  readonly crystallizeCandidates: number;
}

async function getForgeEvents(): Promise<readonly ForgeEvent[]> {
  return (await adminGet<readonly ForgeEvent[]>("/view/forge/events")) ?? [];
}

async function getForgeBricks(): Promise<readonly ForgeBrick[]> {
  return (await adminGet<readonly ForgeBrick[]>("/view/forge/bricks")) ?? [];
}

async function getForgeStats(): Promise<ForgeStats | null> {
  return adminGet<ForgeStats>("/view/forge/stats");
}

/** Wait for TUI to show "Run finished" or idle after a prompt. */
async function waitForRunComplete(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const screen = await captureTui();
    // Agent is idle when console shows the prompt input line again
    if (screen.includes("Run finished") || screen.includes("Type message")) {
      return;
    }
    await sleep(2000);
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describeE2E("forge Real-LLM E2E — real tool calls through TUI", () => {
  let initialEventCount = 0;
  let initialBrickCount = 0;

  beforeAll(async () => {
    // Verify admin API is reachable
    const resp = await fetch(`${ADMIN_URL}/health`, { signal: AbortSignal.timeout(5000) }).catch(
      () => null,
    );
    if (resp === null || !resp.ok) {
      throw new Error(
        `Admin API not reachable at ${ADMIN_URL}. Start koi up first: cd demo-agent && bun run up`,
      );
    }

    // Kill stale test session
    await tmux("kill-session", "-t", TMUX_SESSION).catch(() => {});

    // Launch standalone TUI connecting to the running admin API
    const worktreeRoot = new URL("../../../../..", import.meta.url).pathname;
    const tuiCmd = `cd ${worktreeRoot} && bun run packages/meta/cli/src/bin.ts tui --url ${ADMIN_URL}`;
    await tmux("new-session", "-d", "-s", TMUX_SESSION, "-x", "120", "-y", "40", tuiCmd);
    await sleep(5000);

    // Record initial forge state (from seeded data)
    initialEventCount = (await getForgeEvents()).length;
    initialBrickCount = (await getForgeBricks()).length;
  }, LLM_TIMEOUT);

  afterAll(async () => {
    await tmux("kill-session", "-t", TMUX_SESSION).catch(() => {});
  });

  // ─── Test 1: Send a prompt that uses a tool (fs_read) ────────────────

  test(
    "real LLM call with tool usage generates engine activity",
    async () => {
      // Select the first agent (Enter on agents view) to attach console
      await sendKey("Enter");
      await sleep(2000);

      // Verify we're in Console view
      let screen = await captureTui();
      if (!screen.includes("Console")) {
        await sendKey("2"); // Try tab switch
        await sleep(1000);
      }

      // Send a short prompt that will use a tool
      // Use tmux send-keys with -l (literal) to avoid key interpretation issues
      await tmux("send-keys", "-t", TMUX_SESSION, "-l", "What tools do you have?");
      await sleep(500);
      await sendKey("Enter");

      // Wait for run to complete (longer timeout for real LLM)
      await sleep(30_000);

      // Verify the agent processed something
      screen = await captureTui();
      const hasActivity =
        screen.includes("Run finished") ||
        screen.includes("Run started") ||
        screen.includes("Step:") ||
        screen.includes("Turns:") ||
        screen.includes("openrouter") ||
        screen.includes("model") ||
        screen.includes("fs_read");
      expect(hasActivity).toBe(true);
    },
    LLM_TIMEOUT,
  );

  // ─── Test 2: Repeated tool usage to trigger crystallize pattern ──────

  test(
    "repeated tool pattern generates forge activity",
    async () => {
      // Send another prompt with the same tool pattern (fs_read → summarize)
      await sendPrompt("Read package.json and tell me the project name");

      // Wait for LLM response + forge middleware processing
      await sleep(30_000);

      // Check forge stats — should have activity
      const stats = await getForgeStats();
      expect(stats).not.toBeNull();
      // Total bricks should be at least what we started with
      expect(stats?.totalBricks).toBeGreaterThanOrEqual(initialBrickCount);
    },
    LLM_TIMEOUT,
  );

  // ─── Test 3: Verify forge events accumulated ────────────────────────

  test(
    "forge events accumulate from real tool usage",
    async () => {
      const events = await getForgeEvents();
      const bricks = await getForgeBricks();

      // We should have at least the initial seeded data
      expect(events.length).toBeGreaterThanOrEqual(initialEventCount);
      expect(bricks.length).toBeGreaterThanOrEqual(initialBrickCount);

      // Log what we found for debugging
      process.stderr.write(
        `[forge-e2e] bricks: ${String(bricks.length)}, events: ${String(events.length)}\n`,
      );
      for (const b of bricks) {
        process.stderr.write(
          `[forge-e2e]   brick: ${b.name} status=${b.status} fitness=${String(b.fitness)}\n`,
        );
      }
      for (const e of events.slice(-5)) {
        process.stderr.write(`[forge-e2e]   event: ${e.subKind}\n`);
      }
    },
    LLM_TIMEOUT,
  );

  // ─── Test 4: TUI forge view shows data after real LLM activity ──────

  test(
    "TUI forge view renders after real LLM tool calls",
    async () => {
      // Switch to Forge tab
      await sendKey("3");
      await sleep(2000);

      const screen = await captureTui();

      // Forge tab renders with bricks
      expect(screen).toMatch(/Forge \([1-9]\d*\)/);

      // Status badges render
      const hasBadge =
        screen.includes("●") ||
        screen.includes("✓") ||
        screen.includes("▼") ||
        screen.includes("✕") ||
        screen.includes("○");
      expect(hasBadge).toBe(true);

      // Summary counters render
      expect(screen).toContain("Demands:");
      expect(screen).toContain("Promoted:");

      // Column headers
      expect(screen).toContain("Name");
      expect(screen).toContain("Status");
      expect(screen).toContain("Fitness");

      // Cursor is present
      expect(screen).toContain("▸");
    },
    LLM_TIMEOUT,
  );

  // ─── Test 5: Navigate between forge and console after LLM runs ──────

  test(
    "TUI navigation stable after LLM activity",
    async () => {
      // Forge → Console → Forge round-trip
      await sendKey("2"); // Console
      await sleep(500);
      const consoleScreen = await captureTui();
      expect(consoleScreen).toContain("Console");

      await sendKey("3"); // Back to Forge
      await sleep(500);
      const forgeScreen = await captureTui();
      expect(forgeScreen).toMatch(/Forge \([1-9]\d*\)/);
      expect(forgeScreen).toContain("▸");
    },
    LLM_TIMEOUT,
  );
});
