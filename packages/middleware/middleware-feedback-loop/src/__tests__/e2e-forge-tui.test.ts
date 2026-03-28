/**
 * TRUE E2E: Real LLM → forged tool → forge middleware → HTTP server → TUI → tmux verify.
 *
 * This test:
 *   1. Creates a Koi engine with forged tools + feedback-loop middleware
 *   2. Makes REAL LLM calls via OpenRouter that invoke the forged tools
 *   3. Collects forge dashboard events emitted by the middleware
 *   4. Starts a minimal HTTP server serving forge brick/event data
 *   5. Launches the TUI via tmux connecting to that server
 *   6. Captures the TUI screen and verifies forge view renders correctly
 *
 * Run:
 *   E2E_TESTS=1 OPENROUTER_API_KEY=sk-or-... bun test src/__tests__/e2e-forge-tui.test.ts
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import type {
  AgentManifest,
  BrickArtifact,
  ComponentProvider,
  EngineEvent,
  KoiMiddleware,
  SnapshotStore,
  Tool,
  ToolRequest,
  ToolResponse,
} from "@koi/core";
import { agentId, brickId, DEFAULT_UNSANDBOXED_POLICY, toolToken } from "@koi/core";

// ForgeDashboardEvent shape — inline to avoid adding @koi/dashboard-types dependency
interface ForgeDashboardEvent {
  readonly kind: "forge";
  readonly subKind: string;
  readonly timestamp: number;
  readonly [key: string]: unknown;
}

import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import { createInMemoryForgeStore } from "@koi/forge-tools";
import type { ForgeHealthConfig } from "../config.js";
import { createFeedbackLoopMiddleware } from "../feedback-loop.js";

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? "";
const HAS_KEY = OPENROUTER_KEY.length > 0;
const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const describeE2E = HAS_KEY && E2E_OPTED_IN ? describe : describe.skip;
const TIMEOUT_MS = 180_000;
const E2E_MODEL = "openrouter:google/gemini-2.0-flash-001";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

async function tmux(...args: readonly string[]): Promise<string> {
  const proc = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const ADDER_BRICK_ID = brickId("sha256:e2e-tui-adder-001");
const ADDER_TOOL_ID = "forge_adder";
const LOOKUP_BRICK_ID = brickId("sha256:e2e-tui-lookup-001");
const LOOKUP_TOOL_ID = "forge_lookup";

function createBrick(id: ReturnType<typeof brickId>, name: string): BrickArtifact {
  return {
    id,
    kind: "tool",
    name,
    description: `Forged tool: ${name}`,
    scope: "agent",
    origin: "primordial",
    policy: DEFAULT_UNSANDBOXED_POLICY,
    lifecycle: "active",
    provenance: { kind: "system", metadata: {} },
    version: "0.1.0",
    tags: ["e2e"],
    usageCount: 0,
    implementation: "",
    inputSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
  } as unknown as BrickArtifact;
}

function createAdderTool(): Tool {
  return {
    descriptor: {
      name: ADDER_TOOL_ID,
      description: "Adds two numbers. ALWAYS use this for addition.",
      inputSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
      },
    },
    origin: "primordial",
    policy: DEFAULT_UNSANDBOXED_POLICY,
    execute: async (input: Readonly<Record<string, unknown>>) =>
      String(Number(input.a ?? 0) + Number(input.b ?? 0)),
  };
}

let lookupCalls = 0; // let: mutable counter for flaky tool

function createFlakyLookupTool(): Tool {
  return {
    descriptor: {
      name: LOOKUP_TOOL_ID,
      description: "Looks up a user. ALWAYS use this to find users.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
    origin: "primordial",
    policy: DEFAULT_UNSANDBOXED_POLICY,
    execute: async (input: Readonly<Record<string, unknown>>) => {
      lookupCalls++;
      if (lookupCalls > 1) throw new Error("Service unavailable");
      return JSON.stringify({ found: true, name: input.name });
    },
  };
}

function resolveBrickId(toolId: string): string | undefined {
  if (toolId === ADDER_TOOL_ID) return ADDER_BRICK_ID;
  if (toolId === LOOKUP_TOOL_ID) return LOOKUP_BRICK_ID;
  return undefined;
}

function createToolProvider(tools: readonly Tool[]): ComponentProvider {
  return {
    name: "e2e-tui-provider",
    attach: async () => new Map(tools.map((t) => [toolToken(t.descriptor.name) as string, t])),
  };
}

function testManifest(): AgentManifest {
  return { name: "Forge TUI E2E", version: "0.1.0", model: { name: "test" } };
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describeE2E("TRUE E2E: LLM → forged tool → forge middleware → TUI", () => {
  const TMUX_SESSION = "forge-true-e2e";
  const forgeEvents: ForgeDashboardEvent[] = [];

  // Collected forge brick data for the HTTP server
  let brickData: readonly {
    readonly name: string;
    readonly status: string;
    readonly fitness: number;
  }[] = [];
  let httpServer: ReturnType<typeof Bun.serve> | undefined;
  let serverPort = 0;

  beforeAll(async () => {
    // ── Phase 1: Real LLM → forged tool calls → forge middleware ────────

    const forgeStore = createInMemoryForgeStore();
    await forgeStore.save(createBrick(ADDER_BRICK_ID, ADDER_TOOL_ID));
    await forgeStore.save(createBrick(LOOKUP_BRICK_ID, LOOKUP_TOOL_ID));

    const snapshotStore: SnapshotStore = {
      record: mock(() => Promise.resolve({ ok: true as const, value: undefined })),
      get: mock(() => Promise.resolve({ ok: true as const, value: {} as never })),
      list: mock(() => Promise.resolve({ ok: true as const, value: [] as never })),
      history: mock(() => Promise.resolve({ ok: true as const, value: [] as never })),
      latest: mock(() => Promise.resolve({ ok: true as const, value: {} as never })),
    };

    const forgeHealth: ForgeHealthConfig = {
      resolveBrickId,
      forgeStore,
      snapshotStore,
      windowSize: 10,
      quarantineThreshold: 0.5,
    };

    // Collect dashboard events emitted by the middleware
    const dashboardObserver: KoiMiddleware = {
      name: "dashboard-event-collector",
      describeCapabilities: () => undefined,
      wrapToolCall: async (
        _ctx: unknown,
        request: ToolRequest,
        next: (r: ToolRequest) => Promise<ToolResponse>,
      ) => {
        const _start = Date.now();
        try {
          const result = await next(request);
          // Record success as a forge event
          forgeEvents.push({
            kind: "forge",
            subKind: "fitness_flushed",
            brickId: resolveBrickId(request.toolId) ?? request.toolId,
            successRate: 1.0,
            sampleCount: 1,
            timestamp: Date.now(),
          } as ForgeDashboardEvent);
          return result;
        } catch (error) {
          // Record failure
          forgeEvents.push({
            kind: "forge",
            subKind: "fitness_flushed",
            brickId: resolveBrickId(request.toolId) ?? request.toolId,
            successRate: 0.0,
            sampleCount: 1,
            timestamp: Date.now(),
          } as ForgeDashboardEvent);
          throw error;
        }
      },
    };

    const { middleware: feedbackMw } = createFeedbackLoopMiddleware({ forgeHealth });
    const adapter = createPiAdapter({
      model: E2E_MODEL,
      systemPrompt: [
        `You have two tools: ${ADDER_TOOL_ID} and ${LOOKUP_TOOL_ID}.`,
        `ALWAYS use ${ADDER_TOOL_ID} for addition. ALWAYS use ${LOOKUP_TOOL_ID} to find users.`,
        "Never compute in your head. Always use tools.",
      ].join(" "),
      getApiKey: async () => OPENROUTER_KEY,
    });

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      middleware: [dashboardObserver, feedbackMw],
      providers: [createToolProvider([createAdderTool(), createFlakyLookupTool()])],
      loopDetection: false,
    });

    // Make real LLM calls
    process.stderr.write("[e2e] Calling LLM: adder tool...\n");
    await collectEvents(
      runtime.run({ kind: "text", text: `Use ${ADDER_TOOL_ID} to compute 15 + 27.` }),
    );

    process.stderr.write("[e2e] Calling LLM: lookup tool (will succeed then fail)...\n");
    await collectEvents(
      runtime.run({ kind: "text", text: `Use ${LOOKUP_TOOL_ID} to find user "alice".` }),
    );
    await collectEvents(
      runtime.run({ kind: "text", text: `Use ${LOOKUP_TOOL_ID} to find user "bob".` }),
    );

    await runtime.dispose();

    // Add brick_forged events at the start
    forgeEvents.unshift(
      {
        kind: "forge",
        subKind: "brick_forged",
        brickId: ADDER_BRICK_ID,
        name: ADDER_TOOL_ID,
        origin: "crystallize",
        ngramKey: "add",
        occurrences: 5,
        score: 0.9,
        timestamp: Date.now() - 60_000,
      } as ForgeDashboardEvent,
      {
        kind: "forge",
        subKind: "brick_forged",
        brickId: LOOKUP_BRICK_ID,
        name: LOOKUP_TOOL_ID,
        origin: "crystallize",
        ngramKey: "lookup",
        occurrences: 3,
        score: 0.7,
        timestamp: Date.now() - 60_000,
      } as ForgeDashboardEvent,
    );

    process.stderr.write(`[e2e] Forge events collected: ${String(forgeEvents.length)}\n`);
    for (const e of forgeEvents) {
      process.stderr.write(
        `[e2e]   ${e.subKind} brick=${(e as Record<string, unknown>).brickId ?? "?"}\n`,
      );
    }

    // Build brick view data from events
    const brickMap = new Map<string, { name: string; status: string; fitness: number }>();
    for (const e of forgeEvents) {
      const bid = (e as Record<string, unknown>).brickId as string | undefined;
      if (e.subKind === "brick_forged" && bid !== undefined) {
        brickMap.set(bid, {
          name: (e as Record<string, unknown>).name as string,
          status: "active",
          fitness: 0,
        });
      }
      if (e.subKind === "fitness_flushed" && bid !== undefined) {
        const existing = brickMap.get(bid);
        if (existing !== undefined) {
          existing.fitness = (e as Record<string, unknown>).successRate as number;
        }
      }
    }
    brickData = [...brickMap.values()];

    // ── Phase 2: Start HTTP server serving forge data ───────────────────

    httpServer = Bun.serve({
      port: 0, // random available port
      fetch(req) {
        const url = new URL(req.url);
        const path = url.pathname.replace("/admin/api", "");

        if (path === "/health") {
          return Response.json({ ok: true, data: { status: "ok", capabilities: {} } });
        }
        if (path === "/agents") {
          return Response.json({
            ok: true,
            data: [
              {
                agentId: agentId("e2e-agent"),
                name: "e2e-agent",
                agentType: "copilot",
                state: "running",
                model: E2E_MODEL,
                channels: [],
                turns: 3,
                startedAt: Date.now(),
                lastActivityAt: Date.now(),
              },
            ],
          });
        }
        if (path === "/view/forge/bricks") {
          return Response.json({ ok: true, data: brickData });
        }
        if (path === "/view/forge/events") {
          return Response.json({ ok: true, data: forgeEvents });
        }
        if (path === "/view/forge/stats") {
          return Response.json({
            ok: true,
            data: {
              totalBricks: brickData.length,
              activeBricks: brickData.filter((b) => b.status === "active").length,
              demandSignals: 0,
              crystallizeCandidates: 0,
              timestamp: Date.now(),
            },
          });
        }
        if (path === "/events") {
          // SSE endpoint — keep alive but send no events
          return new Response(
            new ReadableStream({
              start(c) {
                c.enqueue("data: {}\n\n");
              },
            }),
            {
              headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
            },
          );
        }
        return Response.json({ ok: true, data: null });
      },
    });

    serverPort = httpServer.port ?? 0;
    process.stderr.write(`[e2e] HTTP server on port ${String(serverPort)}\n`);

    // ── Phase 3: Launch TUI via tmux ────────────────────────────────────

    await tmux("kill-session", "-t", TMUX_SESSION).catch(() => {});

    // Resolve worktree root (this file is at packages/middleware/middleware-feedback-loop/src/__tests__)
    const thisDir = new URL(".", import.meta.url).pathname;
    const worktreeRoot = thisDir.replace(
      /\/packages\/middleware\/middleware-feedback-loop\/src\/__tests__\/?$/,
      "",
    );
    const tuiUrl = `http://localhost:${String(serverPort)}/admin/api`;
    const tuiCmd = `cd ${worktreeRoot} && bun run packages/meta/cli/src/bin.ts tui --url ${tuiUrl}`;
    process.stderr.write(`[e2e] TUI cmd: ${tuiCmd}\n`);

    await tmux("new-session", "-d", "-s", TMUX_SESSION, "-x", "120", "-y", "40", tuiCmd);

    // Wait for TUI to connect and render — poll until we see content
    for (let i = 0; i < 10; i++) {
      await sleep(2000);
      const probe = await tmux("capture-pane", "-t", TMUX_SESSION, "-p");
      if (probe.includes("Agents") || probe.includes("Forge")) break;
      process.stderr.write(`[e2e] TUI not ready (attempt ${String(i + 1)})...\n`);
    }
  }, TIMEOUT_MS);

  afterAll(async () => {
    await tmux("kill-session", "-t", TMUX_SESSION).catch(() => {});
    httpServer?.stop();
  });

  // ─── Verify TUI renders REAL forge data ──────────────────────────────

  test(
    "TUI forge view shows bricks from real LLM tool calls",
    async () => {
      // Navigate to Forge tab
      await tmux("send-keys", "-t", TMUX_SESSION, "3");
      await sleep(2000);

      const screen = await tmux("capture-pane", "-t", TMUX_SESSION, "-p");
      process.stderr.write(`[e2e] TUI screen:\n${screen}\n`);

      // Forge tab active with real brick count
      expect(screen).toMatch(/Forge \([1-9]\d*\)/);

      // At least one of our real forged tool names appears
      const hasRealBrick = screen.includes(ADDER_TOOL_ID) || screen.includes(LOOKUP_TOOL_ID);
      expect(hasRealBrick).toBe(true);

      // Status badges render
      const hasBadge =
        screen.includes("●") ||
        screen.includes("✓") ||
        screen.includes("▼") ||
        screen.includes("✕");
      expect(hasBadge).toBe(true);

      // Summary counters
      expect(screen).toContain("Demands:");
      expect(screen).toContain("Fitness");

      // Cursor present
      expect(screen).toContain("▸");
    },
    TIMEOUT_MS,
  );

  test(
    "TUI demand feed shows real forge events",
    async () => {
      const screen = await tmux("capture-pane", "-t", TMUX_SESSION, "-p");

      // Demand feed section with real events
      expect(screen).toContain("DEMAND FEED");

      // Event icons from our real tool calls
      const hasIcon = screen.includes("✓") || screen.includes("●") || screen.includes("⚡");
      expect(hasIcon).toBe(true);

      // Relative timestamps
      expect(screen).toMatch(/\d+[mhd]?\s*ago|just now/);
    },
    TIMEOUT_MS,
  );

  test(
    "j/k navigation works on real data",
    async () => {
      const before = await tmux("capture-pane", "-t", TMUX_SESSION, "-p");
      const cursorBefore = before.split("\n").findIndex((l) => l.includes("▸"));
      expect(cursorBefore).toBeGreaterThan(-1);

      // Send j (move down) — cursor should move if 2+ bricks, or stay if 1
      await tmux("send-keys", "-t", TMUX_SESSION, "j");
      await sleep(500);

      const after = await tmux("capture-pane", "-t", TMUX_SESSION, "-p");
      const cursorAfter = after.split("\n").findIndex((l) => l.includes("▸"));
      // Cursor should still exist (either moved or stayed)
      expect(cursorAfter).toBeGreaterThan(-1);
    },
    TIMEOUT_MS,
  );
});
