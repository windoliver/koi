/**
 * E2E: ACE tools provider wiring through createForgeConfiguredKoi.
 *
 * Validates that when ACE middleware is present in the resolved middleware:
 *   1. list_playbooks tool is attached to the agent entity
 *   2. ace-self-forge skill is attached to the agent entity
 *   3. LLM can call list_playbooks and get structured results
 *   4. ACE tools work alongside forge tools when forge is enabled
 *   5. ACE tools still attach when forge is disabled (fast path)
 *
 * Gated on OPENROUTER_API_KEY + E2E_TESTS=1.
 *
 * Run:
 *   E2E_TESTS=1 bun test packages/meta/forge/src/__tests__/e2e-ace-tools.test.ts
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  AgentManifest,
  EngineEvent,
  EngineOutput,
  KoiMiddleware,
  SandboxExecutor,
} from "@koi/core";
import { skillToken, toolToken } from "@koi/core";
import { createPiAdapter } from "@koi/engine-pi";
import { createInMemoryForgeStore } from "@koi/forge-tools";
import { descriptor as aceDescriptor, getAceStores } from "@koi/middleware-ace";
import type { ResolutionContext } from "@koi/resolve";
import { createForgeConfiguredKoi } from "../configured-koi.js";

// ---------------------------------------------------------------------------
// Environment gate — load OpenRouter key from ~/nexus/.env
// ---------------------------------------------------------------------------

function loadEnvFile(path: string): Record<string, string> {
  try {
    const content = readFileSync(path, "utf-8");
    const vars: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      vars[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
    }
    return vars;
  } catch {
    return {};
  }
}

const nexusEnv = loadEnvFile(resolve(process.env.HOME ?? "~", "nexus/.env"));
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? nexusEnv.OPENROUTER_API_KEY ?? "";
const HAS_KEY = OPENROUTER_KEY.length > 0;
const E2E_ENABLED = HAS_KEY && process.env.E2E_TESTS === "1";
const describeE2E = E2E_ENABLED ? describe : describe.skip;

const TIMEOUT_MS = 120_000;
const E2E_MODEL = "openrouter:google/gemini-2.0-flash-001";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ForgeManifest = AgentManifest & { readonly forge: unknown };

function forgeManifest(): ForgeManifest {
  return {
    name: "ace-tools-e2e",
    version: "0.1.0",
    model: { name: E2E_MODEL },
    forge: { enabled: true },
  } as ForgeManifest;
}

function noForgeManifest(): ForgeManifest {
  return {
    name: "ace-tools-no-forge-e2e",
    version: "0.1.0",
    model: { name: E2E_MODEL },
    forge: { enabled: false },
  } as ForgeManifest;
}

function mockExecutor(): SandboxExecutor {
  return {
    execute: async (_code, input, _timeout) => ({
      ok: true,
      value: { output: input, durationMs: 1 },
    }),
  };
}

const STUB_RESOLUTION_CONTEXT: ResolutionContext = {
  manifestDir: "/tmp",
  manifest: { name: "ace-e2e" } as AgentManifest,
  env: {},
};

/** Create ACE middleware via the descriptor factory (same path as manifest resolution). */
async function createAceViaDescriptor(): Promise<KoiMiddleware> {
  return aceDescriptor.factory({}, STUB_RESOLUTION_CONTEXT);
}

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: ACE tools provider through createForgeConfiguredKoi", () => {
  // ── 1. ACE tools attached when forge enabled ────────────────────────────

  test(
    "ACE middleware → list_playbooks + ace-self-forge attached to agent (forge enabled)",
    async () => {
      const aceMiddleware = await createAceViaDescriptor();

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Reply with one word only.",
        getApiKey: async () => OPENROUTER_KEY,
      });

      const result = await createForgeConfiguredKoi({
        manifest: forgeManifest(),
        adapter,
        forgeStore: createInMemoryForgeStore(),
        forgeExecutor: mockExecutor(),
        middleware: [aceMiddleware],
      });

      // Run one turn to trigger assembly + attach
      await collectEvents(result.runtime.run({ kind: "text", text: "Hello" }));

      // Verify ACE tools are on the agent entity
      const agent = result.runtime.agent;
      expect(agent.component(toolToken("list_playbooks"))).toBeDefined();
      expect(agent.component(skillToken("ace-self-forge"))).toBeDefined();

      // Forge tools should also be present
      expect(agent.component(toolToken("search_forge"))).toBeDefined();
      expect(agent.component(toolToken("forge_tool"))).toBeDefined();

      await result.runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── 2. ACE tools attached when forge disabled (fast path) ───────────────

  test(
    "ACE middleware → list_playbooks + ace-self-forge attached (forge disabled, fast path)",
    async () => {
      const aceMiddleware = await createAceViaDescriptor();

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Reply with one word only.",
        getApiKey: async () => OPENROUTER_KEY,
      });

      const result = await createForgeConfiguredKoi({
        manifest: noForgeManifest(),
        adapter,
        middleware: [aceMiddleware],
      });

      // No forge system in fast path
      expect(result.forgeSystem).toBeUndefined();

      // Run one turn
      await collectEvents(result.runtime.run({ kind: "text", text: "Hello" }));

      // ACE tools should still be attached
      const agent = result.runtime.agent;
      expect(agent.component(toolToken("list_playbooks"))).toBeDefined();
      expect(agent.component(skillToken("ace-self-forge"))).toBeDefined();

      // Forge tools should NOT be present
      expect(agent.component(toolToken("search_forge"))).toBeUndefined();

      await result.runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── 3. LLM calls list_playbooks and gets structured result ──────────────

  test(
    "LLM calls list_playbooks tool and receives structured playbook data",
    async () => {
      const aceMiddleware = await createAceViaDescriptor();
      const toolCallIds: string[] = [];

      const toolSpy: KoiMiddleware = {
        name: "ace-tool-spy",
        describeCapabilities: () => undefined,
        wrapToolCall: async (_ctx, request, next) => {
          toolCallIds.push(request.toolId);
          return next(request);
        },
      };

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You have a tool called list_playbooks. When asked about playbooks, " +
          "ALWAYS call list_playbooks first. Never guess — always use the tool.",
        getApiKey: async () => OPENROUTER_KEY,
      });

      const result = await createForgeConfiguredKoi({
        manifest: forgeManifest(),
        adapter,
        forgeStore: createInMemoryForgeStore(),
        forgeExecutor: mockExecutor(),
        middleware: [aceMiddleware, toolSpy],
      });

      const events = await collectEvents(
        result.runtime.run({
          kind: "text",
          text: "List all your learned playbooks using list_playbooks. Report what you find.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason === "completed" || output?.stopReason === "max_turns").toBe(true);

      // list_playbooks should have been called
      expect(toolCallIds).toContain("list_playbooks");

      await result.runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── 4. getAceStores returns same store instance used by middleware ───────

  test(
    "getAceStores returns same PlaybookStore used by descriptor-created middleware",
    async () => {
      const aceMiddleware = await createAceViaDescriptor();

      // Verify stores accessible via WeakMap accessor
      const stores = getAceStores(aceMiddleware);
      expect(stores).toBeDefined();
      expect(stores?.playbookStore).toBeDefined();

      // Seed a playbook into the store
      await stores?.playbookStore.save({
        id: "e2e-pb-1",
        title: "E2E Test Playbook",
        strategy: "Test strategy",
        tags: ["e2e"],
        confidence: 0.95,
        source: "curated",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sessionCount: 5,
      });

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You MUST call list_playbooks when asked about playbooks. " +
          "Report the titles of any playbooks found.",
        getApiKey: async () => OPENROUTER_KEY,
      });

      const result = await createForgeConfiguredKoi({
        manifest: forgeManifest(),
        adapter,
        forgeStore: createInMemoryForgeStore(),
        forgeExecutor: mockExecutor(),
        middleware: [aceMiddleware],
      });

      const events = await collectEvents(
        result.runtime.run({
          kind: "text",
          text: "Use list_playbooks to see what playbooks you have learned. Tell me their titles.",
        }),
      );

      const text = extractText(events);
      // The seeded playbook should appear in the response
      expect(text).toContain("E2E Test Playbook");

      await result.runtime.dispose();
    },
    TIMEOUT_MS,
  );
});
