/**
 * E2E: Engine Capability Cards (#548) — companion skills on BrickDescriptor.
 *
 * Validates the full vertical slice:
 *   1. Registry: engine descriptors with description, tags, companionSkills register correctly
 *   2. Metadata: all 5 engines expose well-formed companion skill content
 *   3. Runtime: createKoi + createPiAdapter with descriptor-selected engine → real LLM call
 *   4. Middleware: companion skill metadata is accessible at resolution time
 *   5. Tool chain: real multi-turn tool call through the full L1 middleware chain
 *
 * Run:
 *   E2E_TESTS=1 ANTHROPIC_API_KEY=sk-ant-... bun test src/__tests__/e2e-capability-cards.test.ts
 */

import { describe, expect, test } from "bun:test";
import type {
  AgentManifest,
  ComponentProvider,
  EngineEvent,
  EngineOutput,
  KoiMiddleware,
  Tool,
  ToolRequest,
  ToolResponse,
} from "@koi/core";
import { skillToken, toolToken } from "@koi/core";
import type { SkillComponent } from "@koi/core/ecs";
import { descriptor as acpDescriptor } from "@koi/engine-acp";
import { descriptor as claudeDescriptor } from "@koi/engine-claude";
import { descriptor as externalDescriptor } from "@koi/engine-external";
import { descriptor as loopDescriptor } from "@koi/engine-loop";
import { createPiAdapter, descriptor as piDescriptor } from "@koi/engine-pi";
import type { BrickDescriptor } from "@koi/resolve";
import { createRegistry } from "@koi/resolve";
import { createKoi } from "../koi.js";

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
// All engine descriptors
// ---------------------------------------------------------------------------

const ALL_ENGINE_DESCRIPTORS: readonly BrickDescriptor<unknown>[] = [
  piDescriptor,
  acpDescriptor,
  loopDescriptor,
  externalDescriptor,
  claudeDescriptor,
];

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
    name: "capability-cards-e2e",
    version: "0.1.0",
    model: { name: "claude-haiku-4-5" },
  };
}

const LOOKUP_TOOL: Tool = {
  descriptor: {
    name: "lookup_engine",
    description:
      "Looks up an engine by name and returns its description and tags. Available engines: pi, acp, loop, external, claude.",
    inputSchema: {
      type: "object",
      properties: {
        engine_name: {
          type: "string",
          description: "Engine name to look up",
        },
      },
      required: ["engine_name"],
    },
  },
  trustTier: "sandbox",
  execute: async (input: Readonly<Record<string, unknown>>) => {
    const name = String(input.engine_name ?? "");
    const desc = ALL_ENGINE_DESCRIPTORS.find(
      (d) => d.aliases?.includes(name) || d.name.includes(name),
    );
    if (desc === undefined) {
      return JSON.stringify({ error: `Engine "${name}" not found` });
    }
    return JSON.stringify({
      name: desc.name,
      description: desc.description,
      tags: desc.tags,
      companionSkillCount: desc.companionSkills?.length ?? 0,
      companionSkillName: desc.companionSkills?.[0]?.name ?? null,
    });
  },
};

function createToolProvider(tools: readonly Tool[]): ComponentProvider {
  return {
    name: "e2e-capability-cards-tools",
    attach: async () => new Map(tools.map((t) => [toolToken(t.descriptor.name) as string, t])),
  };
}

/**
 * ComponentProvider that injects companion skills as SkillComponents onto the agent.
 * Simulates what #546 will do automatically.
 */
function createCompanionSkillProvider(
  descriptors: readonly BrickDescriptor<unknown>[],
): ComponentProvider {
  return {
    name: "companion-skill-injector",
    attach: async () => {
      const entries: Array<readonly [string, SkillComponent]> = [];
      for (const desc of descriptors) {
        if (desc.companionSkills === undefined) continue;
        for (const skill of desc.companionSkills) {
          const component: SkillComponent = {
            name: skill.name,
            description: skill.description,
            content: skill.content,
            tags: skill.tags ? [...skill.tags] : undefined,
          };
          entries.push([skillToken(skill.name) as string, component] as const);
        }
      }
      return new Map(entries);
    },
  };
}

// =========================================================================
// Part 1: Registry — descriptors register with new metadata (no LLM call)
// =========================================================================

describe("capability cards: registry integration", () => {
  test("all engine descriptors register successfully with companion skills", () => {
    const result = createRegistry([...ALL_ENGINE_DESCRIPTORS]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`Registry creation failed: ${result.error.message}`);

    const engines = result.value.list("engine");
    expect(engines).toHaveLength(5);
  });

  test("each engine descriptor has description, tags, and companionSkills", () => {
    for (const desc of ALL_ENGINE_DESCRIPTORS) {
      expect(desc.description).toBeDefined();
      expect(typeof desc.description).toBe("string");
      expect(desc.description?.length ?? 0).toBeGreaterThan(10);

      expect(desc.tags).toBeDefined();
      expect(desc.tags?.length ?? 0).toBeGreaterThan(0);

      expect(desc.companionSkills).toBeDefined();
      expect(desc.companionSkills?.length ?? 0).toBeGreaterThanOrEqual(1);
    }
  });

  test("companion skills are well-formed with required sections", () => {
    for (const desc of ALL_ENGINE_DESCRIPTORS) {
      for (const skill of desc.companionSkills ?? []) {
        // Required fields
        expect(skill.name.length).toBeGreaterThan(0);
        expect(skill.description.length).toBeGreaterThan(0);
        expect(skill.content.length).toBeGreaterThan(50);

        // Content must include key sections
        expect(skill.content).toContain("## When to use");
        expect(skill.content).toContain("## When NOT to use");
        expect(skill.content).toContain("## Manifest example");
        expect(skill.content).toContain("## Required options");

        // Tags must include "engine"
        expect(skill.tags).toBeDefined();
        expect(skill.tags).toContain("engine");
      }
    }
  });

  test("registry lookup by alias returns descriptor with companion skills", () => {
    const result = createRegistry([...ALL_ENGINE_DESCRIPTORS]);
    if (!result.ok) throw new Error("Registry creation failed");

    const piByAlias = result.value.get("engine", "pi");
    expect(piByAlias).toBeDefined();
    expect(piByAlias?.companionSkills?.[0]?.name).toBe("engine-pi-guide");

    const acpByAlias = result.value.get("engine", "acp");
    expect(acpByAlias?.companionSkills?.[0]?.name).toBe("engine-acp-guide");

    const loopByAlias = result.value.get("engine", "loop");
    expect(loopByAlias?.companionSkills?.[0]?.name).toBe("engine-loop-guide");

    const extByAlias = result.value.get("engine", "external");
    expect(extByAlias?.companionSkills?.[0]?.name).toBe("engine-external-guide");

    const claudeByAlias = result.value.get("engine", "claude");
    expect(claudeByAlias?.companionSkills?.[0]?.name).toBe("engine-claude-guide");
  });

  test("companion skill names are unique across all engines", () => {
    const names = new Set<string>();
    for (const desc of ALL_ENGINE_DESCRIPTORS) {
      for (const skill of desc.companionSkills ?? []) {
        expect(names.has(skill.name)).toBe(false);
        names.add(skill.name);
      }
    }
    expect(names.size).toBe(5);
  });

  test("tags are distinct per engine (no accidental copy-paste)", () => {
    const tagSets = ALL_ENGINE_DESCRIPTORS.map((d) => new Set(d.tags));
    for (let i = 0; i < tagSets.length; i++) {
      const setI = tagSets[i];
      if (setI === undefined) continue;
      for (let j = i + 1; j < tagSets.length; j++) {
        const setJ = tagSets[j];
        if (setJ === undefined) continue;
        const intersection = [...setI].filter((t) => setJ.has(t));
        // Some overlap is fine (e.g., "cli"), but not 100% overlap
        expect(intersection.length).toBeLessThan(setI.size);
      }
    }
  });
});

// =========================================================================
// Part 2: Agent assembly — companion skills attach as SkillComponents
// =========================================================================

describeE2E("capability cards: agent assembly with companion skills", () => {
  test(
    "companion skills are queryable on the assembled agent entity",
    async () => {
      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a concise assistant.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        providers: [createCompanionSkillProvider(ALL_ENGINE_DESCRIPTORS)],
        loopDetection: false,
      });

      // Query all skill components
      const skills = runtime.agent.query<SkillComponent>("skill:");
      const skillNames = [...skills.keys()].map((k) => String(k));

      // All 5 engine companion skills should be attached
      expect(skillNames).toContain("skill:engine-pi-guide");
      expect(skillNames).toContain("skill:engine-acp-guide");
      expect(skillNames).toContain("skill:engine-loop-guide");
      expect(skillNames).toContain("skill:engine-external-guide");
      expect(skillNames).toContain("skill:engine-claude-guide");

      // Verify content of one skill
      const piSkill = runtime.agent.component<SkillComponent>(skillToken("engine-pi-guide"));
      expect(piSkill).toBeDefined();
      expect(piSkill?.content).toContain("## When to use");
      expect(piSkill?.content).toContain("model");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );
});

// =========================================================================
// Part 3: Full L1 runtime — real LLM call validates descriptor-driven engine
// =========================================================================

describeE2E("capability cards: full L1 runtime with real LLM", () => {
  test(
    "pi adapter streams text through createKoi with companion skills attached",
    async () => {
      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a concise assistant. Reply briefly.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        providers: [createCompanionSkillProvider(ALL_ENGINE_DESCRIPTORS)],
        loopDetection: false,
      });

      expect(runtime.agent.state).toBe("created");

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Reply with exactly the word: CAPABILITY_CARD_OK",
        }),
      );

      expect(runtime.agent.state).toBe("terminated");

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");
      expect(output?.metrics.inputTokens).toBeGreaterThan(0);
      expect(output?.metrics.outputTokens).toBeGreaterThan(0);

      const text = extractText(events);
      expect(text.toUpperCase()).toContain("CAPABILITY_CARD_OK");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "LLM uses lookup_engine tool through middleware chain to query descriptor metadata",
    async () => {
      // let: track tool calls through middleware
      let toolCallCount = 0;
      const observedTools: string[] = [];

      const observer: KoiMiddleware = {
        name: "capability-card-observer",
        describeCapabilities: () => undefined,
        wrapToolCall: async (
          _ctx: unknown,
          request: ToolRequest,
          next: (r: ToolRequest) => Promise<ToolResponse>,
        ) => {
          toolCallCount++;
          observedTools.push(request.toolId);
          return next(request);
        },
      };

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You have a lookup_engine tool. Always use it when asked about engines. Never guess — use the tool.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [observer],
        providers: [
          createToolProvider([LOOKUP_TOOL]),
          createCompanionSkillProvider(ALL_ENGINE_DESCRIPTORS),
        ],
        loopDetection: false,
        limits: { maxTurns: 5 },
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: 'Use the lookup_engine tool to look up the engine named "pi". Then tell me: what is its description and how many companion skills does it have?',
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Middleware observed at least one tool call
      expect(toolCallCount).toBeGreaterThanOrEqual(1);
      expect(observedTools).toContain("lookup_engine");

      // Tool call events present
      const toolStarts = events.filter((e) => e.kind === "tool_call_start");
      expect(toolStarts.length).toBeGreaterThanOrEqual(1);

      // Response should reference the pi engine metadata
      const text = extractText(events);
      const textLower = text.toLowerCase();
      expect(
        textLower.includes("pi") ||
          textLower.includes("multi-turn") ||
          textLower.includes("companion"),
      ).toBe(true);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "middleware lifecycle hooks fire with companion skills on agent",
    async () => {
      const hookOrder: string[] = [];

      const lifecycleObserver: KoiMiddleware = {
        name: "capability-lifecycle",
        describeCapabilities: () => undefined,
        onSessionStart: async () => {
          hookOrder.push("session_start");
        },
        onSessionEnd: async () => {
          hookOrder.push("session_end");
        },
        onAfterTurn: async () => {
          hookOrder.push("after_turn");
        },
      };

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Reply with one word.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [lifecycleObserver],
        providers: [createCompanionSkillProvider(ALL_ENGINE_DESCRIPTORS)],
        loopDetection: false,
      });

      // Companion skills should be on the agent before run
      const skills = runtime.agent.query<SkillComponent>("skill:");
      expect(skills.size).toBe(5);

      await collectEvents(runtime.run({ kind: "text", text: "Say: OK" }));

      // Lifecycle correctness
      expect(hookOrder[0]).toBe("session_start");
      expect(hookOrder[hookOrder.length - 1]).toBe("session_end");
      expect(hookOrder).toContain("after_turn");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );
});
