/**
 * Forge TUI E2E — verifies forge view renders correctly in the real TUI.
 *
 * This test assumes koi up is ALREADY running with forge data available.
 * It connects to the running admin API, launches TUI via tmux, and verifies
 * the forge view renders bricks, badges, counters, and navigation.
 *
 * Run:
 *   1. Start the stack:  cd demo-agent && bun run up
 *   2. In another terminal:  E2E_TESTS=1 bun test src/__tests__/forge-tui-e2e.test.ts
 *
 * This lightweight approach avoids OOM kills from running bun test + koi up
 * simultaneously. The test only spawns a TUI process (small) via tmux.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const describeE2E = E2E_OPTED_IN ? describe : describe.skip;
const TIMEOUT = 30_000;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ADMIN_URL = process.env.ADMIN_URL ?? "http://localhost:3100/admin/api";
const TMUX_SESSION = "koi-forge-e2e";

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
  await sleep(500);
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

// ---------------------------------------------------------------------------
// Lifecycle — launch a STANDALONE TUI connected to the running admin API
// ---------------------------------------------------------------------------

describeE2E("forge TUI E2E — real TUI via tmux", () => {
  beforeAll(async () => {
    // Verify admin API is reachable (koi up must be running separately)
    const resp = await fetch(`${ADMIN_URL}/health`, { signal: AbortSignal.timeout(5000) }).catch(
      () => null,
    );
    if (resp === null || !resp.ok) {
      throw new Error(
        `Admin API not reachable at ${ADMIN_URL}. Start koi up first: cd demo-agent && bun run up`,
      );
    }

    // Kill stale session
    await tmux("kill-session", "-t", TMUX_SESSION).catch(() => {});

    // Launch standalone TUI connecting to the running admin API
    const worktreeRoot = new URL("../../../../..", import.meta.url).pathname;
    const tuiCmd = `cd ${worktreeRoot} && bun run packages/meta/cli/src/bin.ts tui --url ${ADMIN_URL}`;
    await tmux("new-session", "-d", "-s", TMUX_SESSION, "-x", "120", "-y", "40", tuiCmd);

    // Wait for TUI to connect and render
    await sleep(5000);
  }, TIMEOUT);

  afterAll(async () => {
    await tmux("kill-session", "-t", TMUX_SESSION).catch(() => {});
  });

  // ─── Admin API ───────────────────────────────────────────────────────

  test(
    "admin API has forge bricks",
    async () => {
      interface BrickView {
        readonly name: string;
        readonly status: string;
      }
      const bricks = await adminGet<readonly BrickView[]>("/view/forge/bricks");
      expect(bricks).not.toBeNull();
      expect(bricks?.length).toBeGreaterThanOrEqual(1);
    },
    TIMEOUT,
  );

  test(
    "admin API has forge stats",
    async () => {
      interface ForgeStats {
        readonly totalBricks: number;
      }
      const stats = await adminGet<ForgeStats>("/view/forge/stats");
      expect(stats).not.toBeNull();
      expect(stats?.totalBricks).toBeGreaterThanOrEqual(1);
    },
    TIMEOUT,
  );

  // ─── TUI forge view rendering ───────────────────────────────────────

  test(
    "forge tab renders brick list with status badges and counters",
    async () => {
      await sendKey("3"); // Switch to Forge tab
      await sleep(2000);

      const screen = await captureTui();

      // Forge tab is active
      expect(screen).toMatch(/Forge.*·/);

      // Brick count > 0
      expect(screen).toMatch(/Forge \([1-9]\d*\)/);

      // Status badge symbol present
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
      expect(screen).toContain("Anomalies:");

      // Column headers render
      expect(screen).toContain("Name");
      expect(screen).toContain("Status");
      expect(screen).toContain("Fitness");
    },
    TIMEOUT,
  );

  test(
    "forge tab has selection cursor",
    async () => {
      const screen = await captureTui();
      expect(screen).toContain("▸");
    },
    TIMEOUT,
  );

  test(
    "j/k navigation moves cursor between bricks",
    async () => {
      const before = await captureTui();
      const cursorBefore = before.split("\n").findIndex((l) => l.includes("▸"));
      expect(cursorBefore).toBeGreaterThan(-1);

      await sendKey("j");
      await sleep(500);

      const after = await captureTui();
      const cursorAfter = after.split("\n").findIndex((l) => l.includes("▸"));
      expect(cursorAfter).toBe(cursorBefore + 1);

      await sendKey("k");
      await sleep(500);

      const restored = await captureTui();
      const cursorRestored = restored.split("\n").findIndex((l) => l.includes("▸"));
      expect(cursorRestored).toBe(cursorBefore);
    },
    TIMEOUT,
  );

  test(
    "Esc returns to agents view",
    async () => {
      await sendKey("Escape");
      await sleep(1000);

      const screen = await captureTui();
      expect(screen).toContain("Agents");
      expect(screen).toMatch(/Agents.*·/);
    },
    TIMEOUT,
  );

  test(
    "tab 3 re-enters forge view",
    async () => {
      await sendKey("3");
      await sleep(1000);

      const screen = await captureTui();
      expect(screen).toMatch(/Forge \([1-9]\d*\)/);
    },
    TIMEOUT,
  );
});
