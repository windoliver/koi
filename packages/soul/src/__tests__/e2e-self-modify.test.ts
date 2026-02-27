/**
 * E2E: Soul self-modification awareness through the full L1 runtime.
 *
 * Validates that the agent actually receives and understands the [Soul System]
 * meta-instruction — that it knows where its personality is defined, that it
 * can propose changes, and that changes require human approval.
 *
 * Run:
 *   E2E_TESTS=1 bun test packages/soul/src/__tests__/e2e-self-modify.test.ts
 *
 * Requires ANTHROPIC_API_KEY in .env (auto-loaded by Bun).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentManifest, EngineEvent, EngineOutput, KoiMiddleware } from "@koi/core";
import type { CapabilityFragment } from "@koi/core/middleware";
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
// Helpers (mirrored from e2e-soul-middleware.test.ts)
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
    name: "E2E Self-Modify Test Agent",
    version: "0.1.0",
    model: { name: "claude-haiku-4-5" },
  };
}

function createAdapter(): ReturnType<typeof createPiAdapter> {
  return createPiAdapter({
    model: E2E_MODEL,
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

describeE2E("e2e: soul self-modification awareness through createKoi + createPiAdapter", () => {
  const setupTmpDir = async (): Promise<void> => {
    tmpDir = join(import.meta.dir, "__e2e_tmp__", crypto.randomUUID());
    await mkdir(tmpDir, { recursive: true });
  };

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // ── Test 1: Agent knows about its personality file ────────────────────

  test(
    "agent knows where its personality is defined (file path awareness)",
    async () => {
      await setupTmpDir();
      await writeFile(
        join(tmpDir, "SOUL.md"),
        "You are a cheerful assistant named Sunny. Always be positive.",
      );

      const result = await runAgent({
        soulOptions: { soul: "SOUL.md", basePath: tmpDir },
        prompt: "Where is your personality defined? Reply with just the file path, nothing else.",
      });

      expect(result.output).toBeDefined();
      expect(result.output?.stopReason).toBe("completed");

      // The LLM should reference SOUL.md — either the full path or the filename
      const text = result.text;
      const knowsFile =
        text.includes("SOUL.md") || text.includes("soul.md") || text.includes("SOUL");
      expect(knowsFile).toBe(true);
    },
    TIMEOUT_MS,
  );

  // ── Test 2: Agent knows it can propose changes ─────────────────────────

  test(
    "agent knows it can propose personality changes via file write",
    async () => {
      await setupTmpDir();
      await writeFile(
        join(tmpDir, "SOUL.md"),
        "You are a concise assistant. Never use more than two sentences.",
      );

      const result = await runAgent({
        soulOptions: { soul: "SOUL.md", basePath: tmpDir },
        prompt: "Can you change your own personality? If so, how? Reply in one sentence.",
      });

      expect(result.output).toBeDefined();
      expect(result.output?.stopReason).toBe("completed");

      const lower = result.text.toLowerCase();
      // The agent should mention writing/modifying the file or proposing changes
      const knowsHowToChange =
        lower.includes("write") ||
        lower.includes("modify") ||
        lower.includes("update") ||
        lower.includes("change") ||
        lower.includes("edit") ||
        lower.includes("propose");
      expect(knowsHowToChange).toBe(true);
    },
    TIMEOUT_MS,
  );

  // ── Test 3: Agent knows changes require human approval ─────────────────

  test(
    "agent knows personality changes require human approval (HITL awareness)",
    async () => {
      await setupTmpDir();
      await writeFile(join(tmpDir, "SOUL.md"), "You are helpful and direct.");

      const result = await runAgent({
        soulOptions: { soul: "SOUL.md", basePath: tmpDir },
        prompt:
          "If you were to change your personality file, would it happen automatically or does something need to happen first? Reply in one sentence.",
      });

      expect(result.output).toBeDefined();
      expect(result.output?.stopReason).toBe("completed");

      const lower = result.text.toLowerCase();
      // The agent should mention approval, human, or permission
      const knowsHitl =
        lower.includes("approval") ||
        lower.includes("human") ||
        lower.includes("permission") ||
        lower.includes("approv") ||
        lower.includes("review") ||
        lower.includes("confirm");
      expect(knowsHitl).toBe(true);
    },
    TIMEOUT_MS,
  );

  // ── Test 4: selfModify=false hides self-modification awareness ─────────

  test(
    "agent does NOT know about self-modification when selfModify is false",
    async () => {
      await setupTmpDir();
      await writeFile(join(tmpDir, "SOUL.md"), "You are a helpful assistant.");

      const result = await runAgent({
        soulOptions: { soul: "SOUL.md", basePath: tmpDir, selfModify: false },
        prompt: "Do you have a personality file that you can modify? Answer only 'yes' or 'no'.",
      });

      expect(result.output).toBeDefined();
      expect(result.output?.stopReason).toBe("completed");

      const lower = result.text.toLowerCase().trim();
      // Without meta-instruction, the agent shouldn't confidently claim it can
      // modify a personality file. It should say "no" or express uncertainty.
      const assertsYes = lower === "yes" || lower === "yes.";
      expect(assertsYes).toBe(false);
    },
    TIMEOUT_MS,
  );

  // ── Test 5: Structural verification — [Soul System] in model request ───

  test(
    "observer middleware confirms [Soul System] meta-instruction in model request",
    async () => {
      await setupTmpDir();
      await writeFile(join(tmpDir, "SOUL.md"), "You are brief and helpful.");

      // let: accumulator for middleware observation
      let soulSystemDetected = false;
      let metaInstructionText = "";

      const observerMw: KoiMiddleware = {
        name: "e2e-meta-observer",
        priority: 501, // Run after soul middleware (500)
        async *wrapModelStream(_ctx, request, next) {
          const firstMsg = request.messages[0];
          if (firstMsg?.senderId === "system:soul" && firstMsg.content[0]?.kind === "text") {
            const text = firstMsg.content[0].text;
            if (text.includes("[Soul System]")) {
              soulSystemDetected = true;
              metaInstructionText = text;
            }
          }
          yield* next(request);
        },
      };

      const soulMw = await createSoulMiddleware({
        soul: "SOUL.md",
        basePath: tmpDir,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: createAdapter(),
        middleware: [soulMw, observerMw],
        loopDetection: false,
      });

      const events = await collectEvents(runtime.run({ kind: "text", text: "Hello." }));
      await runtime.dispose();

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Structural assertion: [Soul System] block was in the model request
      expect(soulSystemDetected).toBe(true);

      // Verify content of meta-instruction
      expect(metaInstructionText).toContain("[Soul System]");
      expect(metaInstructionText).toContain("SOUL.md");
      expect(metaInstructionText).toContain("human approval");
      expect(metaInstructionText).toContain("Do NOT update for:");
    },
    TIMEOUT_MS,
  );

  // ── Test 6: Observer confirms NO meta-instruction when selfModify=false ─

  test(
    "observer confirms [Soul System] block is absent when selfModify is false",
    async () => {
      await setupTmpDir();
      await writeFile(join(tmpDir, "SOUL.md"), "You are brief.");

      // let: accumulator for middleware observation
      let soulSystemDetected = false;

      const observerMw: KoiMiddleware = {
        name: "e2e-meta-observer",
        priority: 501,
        async *wrapModelStream(_ctx, request, next) {
          const firstMsg = request.messages[0];
          if (firstMsg?.senderId === "system:soul" && firstMsg.content[0]?.kind === "text") {
            if (firstMsg.content[0].text.includes("[Soul System]")) {
              soulSystemDetected = true;
            }
          }
          yield* next(request);
        },
      };

      const soulMw = await createSoulMiddleware({
        soul: "SOUL.md",
        basePath: tmpDir,
        selfModify: false,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: createAdapter(),
        middleware: [soulMw, observerMw],
        loopDetection: false,
      });

      const events = await collectEvents(runtime.run({ kind: "text", text: "Hello." }));
      await runtime.dispose();

      expect(findDoneOutput(events)?.stopReason).toBe("completed");
      expect(soulSystemDetected).toBe(false);
    },
    TIMEOUT_MS,
  );

  // ── Test 7: Multi-file awareness with soul + identity + user ───────────

  test(
    "agent is aware of multiple personality files when all layers have file sources",
    async () => {
      await setupTmpDir();
      await writeFile(join(tmpDir, "SOUL.md"), "You are a knowledgeable assistant.");
      await writeFile(join(tmpDir, "USER.md"), "The user is named Bob.");
      await writeFile(join(tmpDir, "persona.md"), "Be friendly on Telegram.");

      // let: accumulator for multi-file observation
      let hasGroupedListing = false;

      const observerMw: KoiMiddleware = {
        name: "e2e-multifile-observer",
        priority: 501,
        async *wrapModelStream(_ctx, request, next) {
          const firstMsg = request.messages[0];
          if (firstMsg?.senderId === "system:soul" && firstMsg.content[0]?.kind === "text") {
            const text = firstMsg.content[0].text;
            // Multi-file mode uses "defined in these files:" with grouped labels
            if (
              text.includes("(global personality)") &&
              text.includes("(channel persona)") &&
              text.includes("(user context)")
            ) {
              hasGroupedListing = true;
            }
          }
          yield* next(request);
        },
      };

      const soulMw = await createSoulMiddleware({
        soul: "SOUL.md",
        identity: {
          personas: [
            {
              channelId: "@koi/channel-telegram",
              name: "TeleBot",
              instructions: { path: "persona.md" },
            },
          ],
        },
        user: "USER.md",
        basePath: tmpDir,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: createAdapter(),
        middleware: [soulMw, observerMw],
        loopDetection: false,
        channelId: "@koi/channel-telegram",
      });

      const events = await collectEvents(runtime.run({ kind: "text", text: "Hello Bob." }));
      await runtime.dispose();

      expect(findDoneOutput(events)?.stopReason).toBe("completed");

      // Structural: observer saw multi-file grouped listing
      expect(hasGroupedListing).toBe(true);
    },
    TIMEOUT_MS,
  );

  // ── Test 8: File routing — observer verifies routing hints in meta-instruction

  test(
    "observer confirms file routing hints in multi-file meta-instruction",
    async () => {
      await setupTmpDir();
      await writeFile(join(tmpDir, "SOUL.md"), "You are knowledgeable.");
      await writeFile(join(tmpDir, "USER.md"), "The user is named Alice.");
      await writeFile(join(tmpDir, "persona.md"), "Be concise on Slack.");

      // let: accumulator for routing hint observation
      let hasRoutingHints = false;

      const observerMw: KoiMiddleware = {
        name: "e2e-routing-observer",
        priority: 501,
        async *wrapModelStream(_ctx, request, next) {
          const firstMsg = request.messages[0];
          if (firstMsg?.senderId === "system:soul" && firstMsg.content[0]?.kind === "text") {
            const text = firstMsg.content[0].text;
            if (
              text.includes("core behavior, tone, values") &&
              text.includes("channel-specific style and rules") &&
              text.includes("user preferences and context")
            ) {
              hasRoutingHints = true;
            }
          }
          yield* next(request);
        },
      };

      const soulMw = await createSoulMiddleware({
        soul: "SOUL.md",
        identity: {
          personas: [
            {
              channelId: "@koi/channel-slack",
              name: "SlackBot",
              instructions: { path: "persona.md" },
            },
          ],
        },
        user: "USER.md",
        basePath: tmpDir,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: createAdapter(),
        middleware: [soulMw, observerMw],
        loopDetection: false,
        channelId: "@koi/channel-slack",
      });

      const events = await collectEvents(runtime.run({ kind: "text", text: "Hello." }));
      await runtime.dispose();

      expect(findDoneOutput(events)?.stopReason).toBe("completed");
      expect(hasRoutingHints).toBe(true);
    },
    TIMEOUT_MS,
  );

  // ── Test 9: Agent distinguishes what to self-modify and what not to ───

  test(
    "agent correctly identifies when NOT to self-modify (transient context)",
    async () => {
      await setupTmpDir();
      await writeFile(join(tmpDir, "SOUL.md"), "You are a thoughtful assistant.");

      const result = await runAgent({
        soulOptions: { soul: "SOUL.md", basePath: tmpDir },
        prompt:
          "I want you to use dark mode for this conversation only. Should you update your personality file for this? Answer only 'yes' or 'no' and explain in one sentence.",
      });

      expect(result.output).toBeDefined();
      expect(result.output?.stopReason).toBe("completed");

      const lower = result.text.toLowerCase();
      // The meta-instruction says "Do NOT update for: One-time task preferences"
      // The LLM should say "no" since dark mode for one conversation is transient
      const saysNo =
        lower.includes("no") ||
        lower.includes("should not") ||
        lower.includes("shouldn't") ||
        lower.includes("not update") ||
        lower.includes("temporary") ||
        lower.includes("transient") ||
        lower.includes("one-time");
      expect(saysNo).toBe(true);
    },
    TIMEOUT_MS,
  );

  // ── Test 10: describeCapabilities reflects selfModify state ────────────

  test(
    "describeCapabilities returns self-modification enabled for file-based soul",
    async () => {
      await setupTmpDir();
      await writeFile(join(tmpDir, "SOUL.md"), "You are helpful.");

      const soulMw = await createSoulMiddleware({
        soul: "SOUL.md",
        basePath: tmpDir,
      });

      const ctx = {
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
      };

      const fragment = soulMw.describeCapabilities?.(ctx) as CapabilityFragment;
      expect(fragment.label).toBe("soul");
      expect(fragment.description).toContain("self-modification enabled");
    },
    TIMEOUT_MS,
  );

  // ── Test 11: Inline soul — no self-modification in describeCapabilities ─

  test(
    "describeCapabilities returns plain 'Persona active' for inline soul content",
    async () => {
      const soulMw = await createSoulMiddleware({
        soul: "Inline personality.\nBe helpful.",
        basePath: "/tmp",
        selfModify: true,
      });

      const ctx = {
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
      };

      const fragment = soulMw.describeCapabilities?.(ctx) as CapabilityFragment;
      expect(fragment.label).toBe("soul");
      expect(fragment.description).toBe("Persona active");
    },
    TIMEOUT_MS,
  );
});
