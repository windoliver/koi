/**
 * Integration test: bootstrap sources → context hydrator end-to-end.
 *
 * Verifies that resolveBootstrap() output can be fed directly
 * into createContextHydrator() and appears in the system message.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextManifestConfig, TextSource } from "@koi/context";
import { createContextHydrator } from "@koi/context";
import { runId, sessionId } from "@koi/core";
import { createMockAgent, createMockTurnContext, createSpyModelHandler } from "@koi/test-utils";
import { resolveBootstrap } from "../resolve.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "koi-bootstrap-integ-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function writeKoiFile(relativePath: string, content: string): Promise<void> {
  const fullPath = join(tempDir, ".koi", relativePath);
  await Bun.write(fullPath, content);
}

describe("bootstrap → context hydrator integration", () => {
  test("bootstrap sources appear in hydrated system message", async () => {
    // 1. Set up .koi/ hierarchy
    await writeKoiFile("INSTRUCTIONS.md", "You are a research agent.");
    await writeKoiFile("TOOLS.md", "Use search tools wisely.");

    // 2. Resolve bootstrap
    const bootstrapResult = await resolveBootstrap({ rootDir: tempDir });
    expect(bootstrapResult.ok).toBe(true);
    if (!bootstrapResult.ok) return;
    expect(bootstrapResult.value.sources).toHaveLength(2);

    // 3. Convert BootstrapTextSource[] to ContextSource[] (structural compatibility)
    const contextSources: readonly TextSource[] = bootstrapResult.value.sources.map((s) => ({
      kind: s.kind,
      text: s.text,
      label: s.label,
      priority: s.priority,
    }));

    // 4. Create hydrator with bootstrap sources
    const agent = createMockAgent();
    const config: ContextManifestConfig = { sources: contextSources };
    const mw = createContextHydrator({ config, agent });

    // 5. Trigger hydration
    await mw.onSessionStart?.({
      agentId: "a",
      sessionId: sessionId("s"),
      runId: runId("r"),
      metadata: {},
    });

    // 6. Capture model call to inspect prepended system message
    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);

    // 7. Assert system message contains bootstrap content
    expect(spy.calls).toHaveLength(1);
    const systemMessage = spy.calls[0]?.messages[0];
    expect(systemMessage).toBeDefined();
    expect(systemMessage?.senderId).toBe("system:context");

    const textBlocks = systemMessage?.content.filter((b) => b.kind === "text") ?? [];
    const fullText = textBlocks.map((b) => ("text" in b ? b.text : "")).join("");
    expect(fullText).toContain("You are a research agent.");
    expect(fullText).toContain("Use search tools wisely.");
  });

  test("bootstrap with agent-specific override flows through hydrator", async () => {
    // Agent-specific file takes priority over project-level
    await writeKoiFile("INSTRUCTIONS.md", "Global instructions.");
    await writeKoiFile("agents/researcher/INSTRUCTIONS.md", "Agent-specific instructions.");

    const bootstrapResult = await resolveBootstrap({
      rootDir: tempDir,
      agentName: "researcher",
    });
    expect(bootstrapResult.ok).toBe(true);
    if (!bootstrapResult.ok) return;

    // Agent-specific overrides project-level entirely
    const instructionSource = bootstrapResult.value.sources.find(
      (s) => s.label === "Agent Instructions",
    );
    expect(instructionSource).toBeDefined();
    expect(instructionSource?.text).toBe("Agent-specific instructions.");

    // Verify it passes through the hydrator
    const contextSources: readonly TextSource[] = bootstrapResult.value.sources.map((s) => ({
      ...s,
    }));
    const agent = createMockAgent();
    const config: ContextManifestConfig = { sources: contextSources };
    const mw = createContextHydrator({ config, agent });

    await mw.onSessionStart?.({
      agentId: "a",
      sessionId: sessionId("s"),
      runId: runId("r"),
      metadata: {},
    });

    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);

    const textBlocks = spy.calls[0]?.messages[0]?.content.filter((b) => b.kind === "text") ?? [];
    const fullText = textBlocks.map((b) => ("text" in b ? b.text : "")).join("");
    expect(fullText).toContain("Agent-specific instructions.");
    expect(fullText).not.toContain("Global instructions.");
  });

  test("bootstrap sources merged with explicit sources in hydrator", async () => {
    await writeKoiFile("INSTRUCTIONS.md", "Bootstrap content.");

    const bootstrapResult = await resolveBootstrap({ rootDir: tempDir });
    expect(bootstrapResult.ok).toBe(true);
    if (!bootstrapResult.ok) return;

    const bootstrapSources: readonly TextSource[] = bootstrapResult.value.sources.map((s) => ({
      ...s,
    }));

    // Combine bootstrap + explicit source
    const allSources: readonly TextSource[] = [
      ...bootstrapSources,
      { kind: "text", text: "Explicit source content.", label: "Explicit", priority: 99 },
    ];

    const agent = createMockAgent();
    const config: ContextManifestConfig = { sources: allSources };
    const mw = createContextHydrator({ config, agent });

    await mw.onSessionStart?.({
      agentId: "a",
      sessionId: sessionId("s"),
      runId: runId("r"),
      metadata: {},
    });

    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);

    const textBlocks = spy.calls[0]?.messages[0]?.content.filter((b) => b.kind === "text") ?? [];
    const fullText = textBlocks.map((b) => ("text" in b ? b.text : "")).join("");
    expect(fullText).toContain("Bootstrap content.");
    expect(fullText).toContain("Explicit source content.");
  });
});
