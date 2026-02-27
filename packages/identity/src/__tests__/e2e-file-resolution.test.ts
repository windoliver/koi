/**
 * E2E: @koi/file-resolution integration through the full createKoi + createPiAdapter stack.
 *
 * Validates that readBoundedFile, truncateSafe, and isValidPathSegment work
 * end-to-end when wired through:
 *   1. Bootstrap — resolves .koi/INSTRUCTIONS.md via readBoundedFile (bounded)
 *   2. Identity  — reads persona instruction files via readBoundedFile (unbounded)
 *   3. Combined  — both feed content into the same LLM call
 *   4. Truncation — oversized files are correctly truncated, markers survive
 *   5. CJK content — multi-byte characters pass through without corruption
 *   6. Hot-reload — identity middleware re-reads persona files after reload()
 *
 * Run:
 *   E2E_TESTS=1 bun test src/__tests__/e2e-file-resolution.test.ts
 *
 * Requires ANTHROPIC_API_KEY in .env (auto-loaded by Bun).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BootstrapTextSource } from "@koi/bootstrap";
import { resolveBootstrap } from "@koi/bootstrap";
import type { AgentManifest, EngineEvent, EngineOutput } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import { createIdentityMiddleware } from "../identity.js";

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
    name: "E2E File-Resolution Agent",
    version: "0.1.0",
    model: { name: "claude-haiku-4-5" },
  };
}

/** Writes a file under the temp directory, creating parent dirs as needed. */
async function writeTestFile(
  basePath: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const fullPath = join(basePath, relativePath);
  const dir = fullPath.slice(0, fullPath.lastIndexOf("/"));
  await mkdir(dir, { recursive: true });
  await Bun.write(fullPath, content);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: file-resolution through full stack", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(import.meta.dir, "__e2e_tmp__", crypto.randomUUID());
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ── Test 1: Bootstrap file resolution feeds into systemPrompt ──────────

  test(
    "bootstrap resolves .koi/INSTRUCTIONS.md and LLM reflects content",
    async () => {
      // 1. Create .koi/INSTRUCTIONS.md with a unique marker
      const marker = `KOIMARKER-${crypto.randomUUID().slice(0, 8)}`;
      await writeTestFile(
        tmpDir,
        ".koi/INSTRUCTIONS.md",
        [
          `You are a test agent with marker: ${marker}.`,
          "When asked about your marker, you MUST repeat it exactly.",
        ].join("\n"),
      );

      // 2. Resolve bootstrap — exercises readBoundedFile with maxChars
      const bootstrapResult = await resolveBootstrap({ rootDir: tmpDir });
      expect(bootstrapResult.ok).toBe(true);
      if (!bootstrapResult.ok) return;

      expect(bootstrapResult.value.sources).toHaveLength(1);
      expect(bootstrapResult.value.warnings).toHaveLength(0);

      // 3. Build system prompt from bootstrap sources
      const systemPrompt = bootstrapResult.value.sources
        .map((s: BootstrapTextSource) => `## ${s.label}\n\n${s.text}`)
        .join("\n\n");
      expect(systemPrompt).toContain(marker);

      // 4. Wire through createKoi + createPiAdapter
      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt,
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        loopDetection: false,
      });

      // 5. Ask the LLM to reflect on the injected content
      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "What is your marker? Reply with ONLY the marker string, nothing else.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      if (output === undefined) return;
      expect(output.stopReason).toBe("completed");

      // 6. LLM response should contain the marker from bootstrap
      const text = extractText(events);
      expect(text).toContain(marker);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 2: Identity middleware with file-based persona instructions ────

  test(
    "identity middleware reads persona file and LLM reflects persona",
    async () => {
      // 1. Create a persona instructions file with personality traits
      // Models reliably reflect persona names and traits — more reliable
      // than token/code instructions which may trigger safety refusals.
      await writeTestFile(
        tmpDir,
        "persona-instructions.md",
        "Always introduce yourself by name first. You love talking about tropical fish.",
      );

      const channelId = "@koi/channel-test";
      const personaName = "Koralia";

      // 2. Create identity middleware with file-based persona
      const identityMiddleware = await createIdentityMiddleware({
        personas: [
          {
            channelId,
            name: personaName,
            instructions: { path: join(tmpDir, "persona-instructions.md") },
          },
        ],
      });

      // 3. Wire through createKoi + createPiAdapter
      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a concise assistant.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [identityMiddleware],
        channelId,
        loopDetection: false,
      });

      // 4. Ask the LLM to introduce itself — persona name should appear
      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Introduce yourself briefly.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      if (output === undefined) return;
      expect(output.stopReason).toBe("completed");

      // 5. LLM response should contain the persona name loaded from the file
      const text = extractText(events).toLowerCase();
      expect(text).toContain(personaName.toLowerCase());

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 3: Bootstrap truncation with oversized file ───────────────────

  test(
    "bootstrap truncates oversized INSTRUCTIONS.md and still resolves",
    async () => {
      // 1. Create .koi/INSTRUCTIONS.md exceeding the default budget (8000 chars)
      const marker = `TRUNCMARKER-${crypto.randomUUID().slice(0, 8)}`;
      const padding = "x".repeat(10_000);
      await writeTestFile(
        tmpDir,
        ".koi/INSTRUCTIONS.md",
        [
          `Your truncation marker is: ${marker}.`,
          "When asked, repeat the marker.",
          "",
          padding,
        ].join("\n"),
      );

      // 2. Resolve bootstrap — readBoundedFile should truncate to 8000 chars
      const bootstrapResult = await resolveBootstrap({ rootDir: tmpDir });
      expect(bootstrapResult.ok).toBe(true);
      if (!bootstrapResult.ok) return;

      expect(bootstrapResult.value.sources).toHaveLength(1);
      const source = bootstrapResult.value.sources[0];
      if (source === undefined) {
        expect(source).toBeDefined();
        return;
      }

      // Content should be truncated
      expect(source.text.length).toBeLessThanOrEqual(8_000);

      // Marker at the start should survive truncation
      expect(source.text).toContain(marker);

      // Truncation warning should be present
      expect(bootstrapResult.value.warnings.length).toBeGreaterThanOrEqual(1);
      const truncWarning = bootstrapResult.value.warnings.find((w: string) =>
        w.includes("truncated"),
      );
      expect(truncWarning).toBeDefined();

      // Resolved slot should have truncation metadata
      const slot = bootstrapResult.value.resolved[0];
      if (slot === undefined) {
        expect(slot).toBeDefined();
        return;
      }
      expect(slot.truncated).toBe(true);
      expect(slot.originalSize).toBeGreaterThan(8_000);

      // 3. Wire truncated content through the LLM
      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: source.text,
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "What is your truncation marker? Reply with ONLY the marker, nothing else.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      if (output === undefined) return;
      expect(output.stopReason).toBe("completed");

      // Marker survives truncation (it was at the start of the file)
      const text = extractText(events);
      expect(text).toContain(marker);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 4: Combined bootstrap + identity through full middleware chain ─

  test(
    "bootstrap + identity middleware both inject content into the same LLM call",
    async () => {
      // 1. Create bootstrap file with a unique marker
      const bootstrapMarker = `BOOT-${crypto.randomUUID().slice(0, 8)}`;
      await writeTestFile(
        tmpDir,
        ".koi/INSTRUCTIONS.md",
        [
          `Your bootstrap code is: ${bootstrapMarker}.`,
          "When asked for your bootstrap code, repeat it exactly.",
        ].join("\n"),
      );

      // 2. Create identity persona file with a different marker
      const identityMarker = `IDENT-${crypto.randomUUID().slice(0, 8)}`;
      await writeTestFile(
        tmpDir,
        "persona.md",
        [
          `Your identity code is: ${identityMarker}.`,
          "When asked for your identity code, repeat it exactly.",
        ].join("\n"),
      );

      const channelId = "@koi/channel-combined-test";

      // 3. Resolve bootstrap
      const bootstrapResult = await resolveBootstrap({ rootDir: tmpDir });
      expect(bootstrapResult.ok).toBe(true);
      if (!bootstrapResult.ok) return;

      const systemPrompt = bootstrapResult.value.sources
        .map((s: BootstrapTextSource) => `## ${s.label}\n\n${s.text}`)
        .join("\n\n");
      expect(systemPrompt).toContain(bootstrapMarker);

      // 4. Create identity middleware
      const identityMiddleware = await createIdentityMiddleware({
        personas: [
          {
            channelId,
            name: "CombinedTestBot",
            instructions: { path: join(tmpDir, "persona.md") },
          },
        ],
      });

      // 5. Wire both through createKoi
      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt,
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [identityMiddleware],
        channelId,
        loopDetection: false,
      });

      // 6. Ask the LLM to reflect on BOTH injected values
      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: [
            "You have two codes assigned to you.",
            "1. What is your bootstrap code?",
            "2. What is your identity code?",
            "Reply with ONLY the two codes, one per line, in the format:",
            "bootstrap: <code>",
            "identity: <code>",
          ].join("\n"),
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      if (output === undefined) return;
      expect(output.stopReason).toBe("completed");

      // 7. LLM response should contain BOTH markers
      const text = extractText(events);
      expect(text).toContain(bootstrapMarker);
      expect(text).toContain(identityMarker);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 5: Bootstrap with CJK content ─────────────────────────────────

  test(
    "bootstrap handles CJK content without corrupting multi-byte characters",
    async () => {
      // CJK characters are 3 bytes per char in UTF-8
      const marker = `CJK-${crypto.randomUUID().slice(0, 8)}`;
      const cjkContent = [
        `标记码: ${marker}`,
        "你好世界。这是一个中文测试文件。",
        "请在被问到标记码时准确重复。",
      ].join("\n");
      await writeTestFile(tmpDir, ".koi/INSTRUCTIONS.md", cjkContent);

      // Resolve bootstrap — should handle CJK without corruption
      const bootstrapResult = await resolveBootstrap({ rootDir: tmpDir });
      expect(bootstrapResult.ok).toBe(true);
      if (!bootstrapResult.ok) return;

      expect(bootstrapResult.value.sources).toHaveLength(1);
      const source = bootstrapResult.value.sources[0];
      if (source === undefined) {
        expect(source).toBeDefined();
        return;
      }

      // Content should be intact (well under budget)
      expect(source.text).toContain(marker);
      expect(source.text).toContain("你好世界");

      // Wire through LLM
      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: source.text,
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "What is 标记码 (the marker code)? Reply with ONLY the code.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      if (output === undefined) return;
      expect(output.stopReason).toBe("completed");

      const text = extractText(events);
      expect(text).toContain(marker);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 6: Identity middleware hot-reload cycle ────────────────────────

  test(
    "identity middleware reload() picks up changed persona file",
    async () => {
      const channelId = "@koi/channel-reload-test";
      const beforeName = "Beforera";
      const afterName = "Afterra";

      // 1. Create initial persona file with a distinctive name
      const personaPath = join(tmpDir, "hot-persona.md");
      await Bun.write(personaPath, "Always introduce yourself by name first.");

      // 2. Create identity middleware
      const identityMiddleware = await createIdentityMiddleware({
        personas: [
          {
            channelId,
            name: beforeName,
            instructions: { path: personaPath },
          },
        ],
      });

      // 3. First run — verify initial persona name appears
      const adapter1 = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a concise assistant.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime1 = await createKoi({
        manifest: testManifest(),
        adapter: adapter1,
        middleware: [identityMiddleware],
        channelId,
        loopDetection: false,
      });

      const events1 = await collectEvents(
        runtime1.run({ kind: "text", text: "Introduce yourself." }),
      );

      const text1 = extractText(events1).toLowerCase();
      expect(text1).toContain(beforeName.toLowerCase());
      await runtime1.dispose();

      // 4. Update the persona file — change name to afterName
      // Since `name` is in the persona config (not the file), we need to
      // rebuild the middleware with the new name to test file reload.
      // Instead, put the name IN the file instructions so reload picks it up.
      await Bun.write(
        personaPath,
        `Your name is ${afterName}. Always introduce yourself by name first.`,
      );

      // 5. Trigger reload — re-reads the file
      await identityMiddleware.reload();

      // 6. Second run — verify updated name appears in response
      const adapter2 = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a concise assistant.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime2 = await createKoi({
        manifest: testManifest(),
        adapter: adapter2,
        middleware: [identityMiddleware],
        channelId,
        loopDetection: false,
      });

      const events2 = await collectEvents(
        runtime2.run({ kind: "text", text: "Introduce yourself." }),
      );

      const text2 = extractText(events2).toLowerCase();
      expect(text2).toContain(afterName.toLowerCase());
      await runtime2.dispose();
    },
    TIMEOUT_MS * 2, // Two LLM calls
  );
});
