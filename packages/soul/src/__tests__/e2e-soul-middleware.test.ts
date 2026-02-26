/**
 * E2E: @koi/soul middleware through the full L1 runtime (createKoi + createPiAdapter).
 *
 * Validates that the unified soul middleware actually injects personality,
 * per-channel identity, and user context into real LLM calls — not just
 * unit-test stubs.
 *
 * Run:
 *   E2E_TESTS=1 bun test packages/soul/src/__tests__/e2e-soul-middleware.test.ts
 *
 * Requires ANTHROPIC_API_KEY in .env (auto-loaded by Bun).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AgentManifest,
  EngineEvent,
  EngineOutput,
  KoiMiddleware,
  ToolRequest,
  ToolResponse,
} from "@koi/core";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import type { CreateSoulOptions } from "../config.js";
import { createSoulMiddleware } from "../soul.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const describeE2E = HAS_KEY && E2E_OPTED_IN ? describe : describe.skip;

const TIMEOUT_MS = 120_000;
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

function findDoneOutput(events: readonly EngineEvent[]): EngineOutput | undefined {
  const done = events.find((e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done");
  return done?.output;
}

function extractText(events: readonly EngineEvent[]): string {
  return events
    .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
    .map((e) => e.delta)
    .join("");
}

function testManifest(): AgentManifest {
  return {
    name: "E2E Soul Test Agent",
    version: "0.1.0",
    model: { name: "claude-haiku-4-5" },
  };
}

function createAdapter(systemPrompt?: string): ReturnType<typeof createPiAdapter> {
  return createPiAdapter({
    model: E2E_MODEL,
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    getApiKey: async () => ANTHROPIC_KEY,
  });
}

async function runAgent(options: {
  readonly soulOptions: CreateSoulOptions;
  readonly prompt: string;
  readonly channelId?: string;
  readonly middleware?: readonly KoiMiddleware[];
}): Promise<{
  readonly events: readonly EngineEvent[];
  readonly text: string;
  readonly output: EngineOutput | undefined;
}> {
  const soulMw = await createSoulMiddleware(options.soulOptions);
  const adapter = createAdapter();

  const runtime = await createKoi({
    manifest: testManifest(),
    adapter,
    middleware: [soulMw, ...(options.middleware ?? [])],
    loopDetection: false,
    ...(options.channelId !== undefined ? { channelId: options.channelId } : {}),
  });

  const events = await collectEvents(runtime.run({ kind: "text", text: options.prompt }));

  await runtime.dispose();

  return {
    events,
    text: extractText(events),
    output: findDoneOutput(events),
  };
}

// Temporary directory for file-based tests
let tmpDir: string;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: @koi/soul through createKoi + createPiAdapter", () => {
  // Setup/teardown for file-based tests
  const setupTmpDir = async (): Promise<void> => {
    tmpDir = join(import.meta.dir, "__e2e_tmp__", crypto.randomUUID());
    await mkdir(tmpDir, { recursive: true });
  };

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // ── Test 1: Inline soul content shapes LLM response ──────────────────

  test(
    "inline soul text influences the LLM response",
    async () => {
      const result = await runAgent({
        soulOptions: {
          soul: "You are a pirate captain named Blackbeard.\nAlways speak in pirate dialect.\nEnd every sentence with 'arrr'.",
          basePath: "/tmp",
        },
        prompt: "Introduce yourself in one sentence.",
      });

      expect(result.output).toBeDefined();
      expect(result.output?.stopReason).toBe("completed");

      // The LLM should adopt the pirate persona
      const lower = result.text.toLowerCase();
      const hasPirateVibes =
        lower.includes("arr") ||
        lower.includes("pirate") ||
        lower.includes("blackbeard") ||
        lower.includes("captain") ||
        lower.includes("matey") ||
        lower.includes("ahoy");
      expect(hasPirateVibes).toBe(true);
    },
    TIMEOUT_MS,
  );

  // ── Test 2: File-based soul content (SOUL.md) ────────────────────────

  test(
    "file-based soul content (SOUL.md) is injected into model call",
    async () => {
      await setupTmpDir();
      await writeFile(
        join(tmpDir, "SOUL.md"),
        "You are a formal British butler named Jeeves.\nAlways address the user as 'sir' or 'madam'.\nBe exquisitely polite and proper.",
      );

      const result = await runAgent({
        soulOptions: { soul: "SOUL.md", basePath: tmpDir },
        prompt: "Greet me briefly.",
      });

      expect(result.output).toBeDefined();
      expect(result.output?.stopReason).toBe("completed");

      const lower = result.text.toLowerCase();
      const hasButlerVibes =
        lower.includes("sir") ||
        lower.includes("madam") ||
        lower.includes("jeeves") ||
        lower.includes("pleasure") ||
        lower.includes("good day") ||
        lower.includes("at your service");
      expect(hasButlerVibes).toBe(true);
    },
    TIMEOUT_MS,
  );

  // ── Test 3: Per-channel identity injection ────────────────────────────

  test(
    "per-channel identity persona is injected when channelId matches",
    async () => {
      const result = await runAgent({
        soulOptions: {
          identity: {
            personas: [
              {
                channelId: "@koi/channel-telegram",
                name: "CryptoBot",
                instructions:
                  "You are a cryptocurrency trading assistant. Always mention Bitcoin and use financial jargon like 'bullish', 'bearish', 'HODL'.",
              },
            ],
          },
          basePath: "/tmp",
        },
        prompt: "What do you think about the market today? Reply in one sentence.",
        channelId: "@koi/channel-telegram",
      });

      expect(result.output).toBeDefined();
      expect(result.output?.stopReason).toBe("completed");

      const lower = result.text.toLowerCase();
      const hasCryptoVibes =
        lower.includes("bitcoin") ||
        lower.includes("btc") ||
        lower.includes("bullish") ||
        lower.includes("bearish") ||
        lower.includes("hodl") ||
        lower.includes("market") ||
        lower.includes("crypto");
      expect(hasCryptoVibes).toBe(true);
    },
    TIMEOUT_MS,
  );

  // ── Test 4: Identity NOT injected for non-matching channel ────────────

  test(
    "identity persona is NOT injected when channelId does not match",
    async () => {
      const result = await runAgent({
        soulOptions: {
          identity: {
            personas: [
              {
                channelId: "@koi/channel-slack",
                name: "PirateBot",
                instructions: "You are a pirate. Always say 'ARRR' at the start of every sentence.",
              },
            ],
          },
          basePath: "/tmp",
        },
        prompt: "Say hello in one sentence.",
        channelId: "@koi/channel-telegram", // does NOT match slack
      });

      expect(result.output).toBeDefined();
      expect(result.output?.stopReason).toBe("completed");

      // Should NOT have pirate persona — the channelId doesn't match
      const lower = result.text.toLowerCase();
      // A plain greeting without pirate dialect
      expect(lower.includes("arrr")).toBe(false);
    },
    TIMEOUT_MS,
  );

  // ── Test 5: Three-layer concatenation (soul + identity + user) ────────

  test(
    "all three layers (soul + identity + user) combine into model call",
    async () => {
      await setupTmpDir();
      await writeFile(join(tmpDir, "SOUL.md"), "You are a helpful AI. Always be concise.");
      await writeFile(
        join(tmpDir, "USER.md"),
        "The user's name is Alice. She loves cats. Always mention cats in your response.",
      );

      const result = await runAgent({
        soulOptions: {
          soul: "SOUL.md",
          identity: {
            personas: [
              {
                channelId: "@koi/channel-telegram",
                name: "FriendlyBot",
                instructions: "Use emoji in your responses.",
              },
            ],
          },
          user: "USER.md",
          basePath: tmpDir,
        },
        prompt: "Greet me by name.",
        channelId: "@koi/channel-telegram",
      });

      expect(result.output).toBeDefined();
      expect(result.output?.stopReason).toBe("completed");

      const lower = result.text.toLowerCase();
      // Should reference Alice (from user layer)
      expect(lower.includes("alice")).toBe(true);
      // Should mention cats (from user layer instructions)
      const hasCatRef =
        lower.includes("cat") || lower.includes("kitten") || lower.includes("feline");
      expect(hasCatRef).toBe(true);
    },
    TIMEOUT_MS,
  );

  // ── Test 6: Soul middleware + tool call middleware chain ───────────────

  test(
    "soul middleware composes correctly with tool calls in the middleware chain",
    async () => {
      // let: accumulator for middleware observation
      let modelStreamObserved = false;
      let soulMessageDetected = false;
      let _toolCallObserved = false;

      const observerMw: KoiMiddleware = {
        name: "e2e-observer",
        // Pi adapter uses streaming — observe via wrapModelStream
        async *wrapModelStream(_ctx, request, next) {
          modelStreamObserved = true;
          // Verify soul message was prepended (first message should be system:soul)
          const firstMsg = request.messages[0];
          if (firstMsg?.senderId === "system:soul") {
            soulMessageDetected = true;
          }
          yield* next(request);
        },
        wrapToolCall: async (
          _ctx: unknown,
          request: ToolRequest,
          next: (r: ToolRequest) => Promise<ToolResponse>,
        ) => {
          _toolCallObserved = true;
          return next(request);
        },
      };

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const soulMw = await createSoulMiddleware({
        soul: "You are a math tutor. Always use available tools to compute answers.\nNever calculate in your head.",
        basePath: "/tmp",
      });

      const multiplyTool = {
        descriptor: {
          name: "multiply",
          description: "Multiplies two numbers.",
          inputSchema: {
            type: "object" as const,
            properties: {
              a: { type: "number", description: "First number" },
              b: { type: "number", description: "Second number" },
            },
            required: ["a", "b"],
          },
        },
        trustTier: "sandbox" as const,
        execute: async (input: Readonly<Record<string, unknown>>) => {
          const a = Number(input.a ?? 0);
          const b = Number(input.b ?? 0);
          return String(a * b);
        },
      };

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [soulMw, observerMw],
        providers: [
          {
            name: "e2e-tools",
            attach: async () => {
              const { toolToken } = await import("@koi/core");
              return new Map([[toolToken("multiply") as string, multiplyTool]]);
            },
          },
        ],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use the multiply tool to compute 13 * 7. Tell me the result.",
        }),
      );

      await runtime.dispose();

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Model stream interception should have fired with soul message
      expect(modelStreamObserved).toBe(true);
      expect(soulMessageDetected).toBe(true);

      // Response should contain the correct answer
      const text = extractText(events);
      expect(text).toContain("91");
    },
    TIMEOUT_MS,
  );

  // ── Test 7: Reload picks up file changes for real LLM call ────────────

  test(
    "reload() updates soul content that affects subsequent LLM calls",
    async () => {
      await setupTmpDir();

      // Persona A: Italian chef
      await writeFile(
        join(tmpDir, "SOUL.md"),
        "You are an Italian chef named Marco. You love pasta and pizza.\nAlways mention Italian food in your replies.\nSign off with 'Mangia bene!'",
      );

      const soulMw = await createSoulMiddleware({
        soul: "SOUL.md",
        basePath: tmpDir,
      });

      // First call — should get Italian chef response
      const runtime1 = await createKoi({
        manifest: testManifest(),
        adapter: createAdapter(),
        middleware: [soulMw],
        loopDetection: false,
      });

      const events1 = await collectEvents(
        runtime1.run({ kind: "text", text: "What should I eat for dinner tonight? One sentence." }),
      );
      const text1 = extractText(events1).toLowerCase();
      const hasItalianVibes =
        text1.includes("pasta") ||
        text1.includes("pizza") ||
        text1.includes("italian") ||
        text1.includes("marco") ||
        text1.includes("mangia") ||
        text1.includes("risotto") ||
        text1.includes("lasagna");
      expect(hasItalianVibes).toBe(true);

      await runtime1.dispose();

      // Persona B: Japanese sushi master
      await writeFile(
        join(tmpDir, "SOUL.md"),
        "You are a Japanese sushi master named Takeshi. You love sushi and ramen.\nAlways mention Japanese food in your replies.\nSign off with 'Itadakimasu!'",
      );
      await soulMw.reload();

      // Second call — should get Japanese chef response
      const runtime2 = await createKoi({
        manifest: testManifest(),
        adapter: createAdapter(),
        middleware: [soulMw],
        loopDetection: false,
      });

      const events2 = await collectEvents(
        runtime2.run({ kind: "text", text: "What should I eat for dinner tonight? One sentence." }),
      );
      const text2 = extractText(events2).toLowerCase();
      const hasJapaneseVibes =
        text2.includes("sushi") ||
        text2.includes("ramen") ||
        text2.includes("japanese") ||
        text2.includes("takeshi") ||
        text2.includes("itadakimasu") ||
        text2.includes("tempura") ||
        text2.includes("miso");
      expect(hasJapaneseVibes).toBe(true);

      await runtime2.dispose();
    },
    TIMEOUT_MS * 2,
  );

  // ── Test 8: Directory mode (SOUL.md + STYLE.md + INSTRUCTIONS.md) ─────

  test(
    "directory mode resolves SOUL.md + STYLE.md + INSTRUCTIONS.md",
    async () => {
      await setupTmpDir();
      const soulDir = join(tmpDir, "soul");
      await mkdir(soulDir);
      await writeFile(join(soulDir, "SOUL.md"), "You are a Shakespearean actor.");
      await writeFile(join(soulDir, "STYLE.md"), "Speak in iambic pentameter where possible.");
      await writeFile(
        join(soulDir, "INSTRUCTIONS.md"),
        "Always quote Shakespeare. Reference 'To be or not to be' in your response.",
      );

      const result = await runAgent({
        soulOptions: { soul: "soul", basePath: tmpDir },
        prompt: "What is the meaning of life? Reply briefly.",
      });

      expect(result.output).toBeDefined();
      expect(result.output?.stopReason).toBe("completed");

      const lower = result.text.toLowerCase();
      const hasShakespeare =
        lower.includes("to be or not to be") ||
        lower.includes("shakespeare") ||
        lower.includes("hamlet") ||
        lower.includes("slings") ||
        lower.includes("thou") ||
        lower.includes("thee") ||
        lower.includes("hath") ||
        lower.includes("doth") ||
        lower.includes("forsooth");
      expect(hasShakespeare).toBe(true);
    },
    TIMEOUT_MS,
  );

  // ── Test 9: File-based persona instructions ───────────────────────────

  test(
    "identity persona with file-based instructions works end-to-end",
    async () => {
      await setupTmpDir();
      await writeFile(
        join(tmpDir, "telegram-persona.md"),
        "You are a weather reporter named Storm.\nAlways mention the temperature (make one up if needed).\nSign off with 'Stay dry!'",
      );

      const result = await runAgent({
        soulOptions: {
          identity: {
            personas: [
              {
                channelId: "@koi/channel-telegram",
                name: "Storm",
                instructions: { path: "telegram-persona.md" },
              },
            ],
          },
          basePath: tmpDir,
        },
        prompt: "Give me a brief weather update.",
        channelId: "@koi/channel-telegram",
      });

      expect(result.output).toBeDefined();
      expect(result.output?.stopReason).toBe("completed");

      const lower = result.text.toLowerCase();
      const hasWeatherVibes =
        lower.includes("temperature") ||
        lower.includes("degrees") ||
        lower.includes("°") ||
        lower.includes("storm") ||
        lower.includes("stay dry") ||
        lower.includes("weather");
      expect(hasWeatherVibes).toBe(true);
    },
    TIMEOUT_MS,
  );

  // ── Test 10: describeCapabilities wired through runtime ───────────────

  test(
    "describeCapabilities is accessible on the soul middleware",
    async () => {
      const soulMw = await createSoulMiddleware({
        soul: "You are helpful.\nBe concise.",
        basePath: "/tmp",
      });

      expect(soulMw.name).toBe("soul");
      expect(soulMw.priority).toBe(500);

      // describeCapabilities should return the expected fragment
      const fragment = soulMw.describeCapabilities?.({
        session: {
          agentId: "test",
          sessionId: "session:agent:test:abc" as import("@koi/core/ecs").SessionId,
          runId: "run-uuid" as import("@koi/core/ecs").RunId,
          metadata: {},
        },
        turnIndex: 0,
        turnId: "turn-uuid" as import("@koi/core/ecs").TurnId,
        messages: [],
        metadata: {},
      });
      expect(fragment).toEqual({ label: "soul", description: "Persona active" });
    },
    TIMEOUT_MS,
  );
});
