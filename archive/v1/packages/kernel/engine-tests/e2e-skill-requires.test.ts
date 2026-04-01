/**
 * E2E: SkillRequiresExtension through the full createKoi runtime.
 *
 * Validates that the skill-requires extension:
 *   1. Fires console.warn at assembly time when skill.requires.tools are missing
 *   2. Does NOT warn when all required tools are present
 *   3. Works with both createLoopAdapter (deterministic) and createPiAdapter (real LLM)
 *   4. Never blocks assembly — agent runs successfully even with warnings
 *   5. Propagates requires from ComponentProvider through the middleware chain
 *
 * Run:
 *   E2E_TESTS=1 ANTHROPIC_API_KEY=sk-ant-... bun test src/__tests__/e2e-skill-requires.test.ts
 */

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type {
  ComponentProvider,
  EngineEvent,
  EngineOutput,
  KoiMiddleware,
  SkillComponent,
  Tool,
  ToolRequest,
  ToolResponse,
} from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY, skillToken, toolToken } from "@koi/core";
import { createLoopAdapter } from "@koi/engine-loop";
import { createPiAdapter } from "@koi/engine-pi";
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

// ---------------------------------------------------------------------------
// Tool & skill definitions
// ---------------------------------------------------------------------------

const MULTIPLY_TOOL: Tool = {
  descriptor: {
    name: "multiply",
    description: "Multiplies two numbers together.",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "number", description: "First number" },
        b: { type: "number", description: "Second number" },
      },
      required: ["a", "b"],
    },
  },
  origin: "primordial",
  policy: DEFAULT_SANDBOXED_POLICY,
  execute: async (input: Readonly<Record<string, unknown>>) => {
    const a = Number(input.a ?? 0);
    const b = Number(input.b ?? 0);
    return String(a * b);
  },
};

const GET_WEATHER_TOOL: Tool = {
  descriptor: {
    name: "get_weather",
    description: "Returns weather for a city. Always returns sunny 22C.",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
  origin: "primordial",
  policy: DEFAULT_SANDBOXED_POLICY,
  execute: async (input: Readonly<Record<string, unknown>>) => {
    return JSON.stringify({ city: String(input.city), temperature: 22, condition: "sunny" });
  },
};

/** ComponentProvider that registers tools on the agent entity. */
function createToolProvider(tools: readonly Tool[]): ComponentProvider {
  return {
    name: "e2e-tool-provider",
    attach: async () => new Map(tools.map((t) => [toolToken(t.descriptor.name) as string, t])),
  };
}

/** ComponentProvider that registers skills with optional requires. */
function createSkillProvider(skills: readonly SkillComponent[]): ComponentProvider {
  return {
    name: "e2e-skill-provider",
    attach: async () => new Map(skills.map((s) => [skillToken(s.name) as string, s])),
  };
}

// ---------------------------------------------------------------------------
// Loop adapter helper (deterministic, no real LLM)
// ---------------------------------------------------------------------------

function createSimpleLoopAdapter() {
  return createLoopAdapter({
    modelCall: async () => ({
      content: "Mock response — skill requires validation happens at assembly time.",
      model: "mock",
      usage: { inputTokens: 10, outputTokens: 20 },
    }),
  });
}

// ---------------------------------------------------------------------------
// Tests — createLoopAdapter (deterministic, fast)
// ---------------------------------------------------------------------------

describe("e2e: SkillRequiresExtension + createLoopAdapter", () => {
  afterEach(() => {
    mock.restore();
  });

  test("warns at assembly when skill requires missing tool", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const skill: SkillComponent = {
      name: "research-skill",
      description: "A research skill",
      content: "# Research\nUse web-search tool.",
      requires: { tools: ["web-search"] },
    };

    const runtime = await createKoi({
      manifest: {
        name: "loop-skill-test",
        version: "1.0.0",
        model: { name: "mock" },
      },
      adapter: createSimpleLoopAdapter(),
      providers: [createToolProvider([MULTIPLY_TOOL]), createSkillProvider([skill])],
      loopDetection: false,
    });

    // Extension should have warned about missing "web-search" tool
    const skillWarns = warnSpy.mock.calls.filter(
      (args) =>
        typeof args[0] === "string" &&
        args[0].includes("research-skill") &&
        args[0].includes("web-search"),
    );
    expect(skillWarns.length).toBe(1);

    // Agent should still be assembled successfully
    expect(runtime.agent.state).toBe("created");

    // Verify the skill is attached (requires propagation proved by the warn above)
    expect(runtime.agent.component(skillToken("research-skill"))).toBeDefined();

    // Agent should run fine despite the warning
    const events = await collectEvents(runtime.run({ kind: "text", text: "hello" }));
    const output = findDoneOutput(events);
    expect(output?.stopReason).toBe("completed");
    expect(runtime.agent.state).toBe("terminated");

    await runtime.dispose();
  });

  test("does NOT warn when all required tools are present", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const skill: SkillComponent = {
      name: "math-skill",
      description: "A math skill",
      content: "# Math\nUse multiply tool.",
      requires: { tools: ["multiply"] },
    };

    const runtime = await createKoi({
      manifest: {
        name: "loop-skill-satisfied",
        version: "1.0.0",
        model: { name: "mock" },
      },
      adapter: createSimpleLoopAdapter(),
      providers: [createToolProvider([MULTIPLY_TOOL]), createSkillProvider([skill])],
      loopDetection: false,
    });

    // No skill-requires warnings (filter out unrelated middleware warnings)
    const skillWarns = warnSpy.mock.calls.filter(
      (args) => typeof args[0] === "string" && args[0].includes("requires tool"),
    );
    expect(skillWarns.length).toBe(0);

    expect(runtime.agent.state).toBe("created");
    await runtime.dispose();
  });

  test("warns for each missing tool in a multi-tool requires", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const skill: SkillComponent = {
      name: "deploy-skill",
      description: "Deploy",
      content: "# Deploy",
      requires: { tools: ["docker-run", "kubectl", "multiply"] },
    };

    const runtime = await createKoi({
      manifest: {
        name: "loop-multi-requires",
        version: "1.0.0",
        model: { name: "mock" },
      },
      adapter: createSimpleLoopAdapter(),
      providers: [createToolProvider([MULTIPLY_TOOL]), createSkillProvider([skill])],
      loopDetection: false,
    });

    // Should warn for docker-run and kubectl (missing), but NOT multiply (present)
    const skillWarns = warnSpy.mock.calls.filter(
      (args) =>
        typeof args[0] === "string" &&
        args[0].includes("deploy-skill") &&
        args[0].includes("requires tool"),
    );
    expect(skillWarns.length).toBe(2);

    // Verify which tools are flagged
    const warnMessages = skillWarns.map((args) => args[0] as string);
    expect(warnMessages.some((m) => m.includes("docker-run"))).toBe(true);
    expect(warnMessages.some((m) => m.includes("kubectl"))).toBe(true);
    expect(warnMessages.some((m) => m.includes("multiply"))).toBe(false);

    // Agent still works
    const events = await collectEvents(runtime.run({ kind: "text", text: "hello" }));
    expect(findDoneOutput(events)?.stopReason).toBe("completed");
    await runtime.dispose();
  });

  test("skill without requires produces no warnings", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const skill: SkillComponent = {
      name: "simple-skill",
      description: "No deps",
      content: "# Simple",
    };

    const runtime = await createKoi({
      manifest: {
        name: "loop-no-requires",
        version: "1.0.0",
        model: { name: "mock" },
      },
      adapter: createSimpleLoopAdapter(),
      providers: [createSkillProvider([skill])],
      loopDetection: false,
    });

    const skillWarns = warnSpy.mock.calls.filter(
      (args) => typeof args[0] === "string" && args[0].includes("requires tool"),
    );
    expect(skillWarns.length).toBe(0);
    await runtime.dispose();
  });

  test("multiple skills with mixed satisfaction", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const satisfiedSkill: SkillComponent = {
      name: "calc-skill",
      description: "Calculator skill",
      content: "Use multiply",
      requires: { tools: ["multiply"] },
    };

    const unsatisfiedSkill: SkillComponent = {
      name: "search-skill",
      description: "Search skill",
      content: "Use web-search",
      requires: { tools: ["web-search", "scraper"] },
    };

    const noRequiresSkill: SkillComponent = {
      name: "help-skill",
      description: "Help skill",
      content: "Just help",
    };

    const runtime = await createKoi({
      manifest: {
        name: "loop-mixed-skills",
        version: "1.0.0",
        model: { name: "mock" },
      },
      adapter: createSimpleLoopAdapter(),
      providers: [
        createToolProvider([MULTIPLY_TOOL]),
        createSkillProvider([satisfiedSkill, unsatisfiedSkill, noRequiresSkill]),
      ],
      loopDetection: false,
    });

    // Only search-skill should produce warnings (2: web-search + scraper)
    const skillWarns = warnSpy.mock.calls.filter(
      (args) => typeof args[0] === "string" && args[0].includes("requires tool"),
    );
    expect(skillWarns.length).toBe(2);
    expect(skillWarns.every((args) => (args[0] as string).includes("search-skill"))).toBe(true);

    // All three skills should be attached regardless
    expect(runtime.agent.component(skillToken("calc-skill"))).toBeDefined();
    expect(runtime.agent.component(skillToken("search-skill"))).toBeDefined();
    expect(runtime.agent.component(skillToken("help-skill"))).toBeDefined();

    await runtime.dispose();
  });

  test("middleware chain fires correctly with skill-requires extension present", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const hookOrder: string[] = [];

    const lifecycleObserver: KoiMiddleware = {
      name: "lifecycle-observer",
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

    const skill: SkillComponent = {
      name: "missing-dep-skill",
      description: "Has missing deps",
      content: "# Missing deps",
      requires: { tools: ["nonexistent-tool"] },
    };

    const runtime = await createKoi({
      manifest: {
        name: "loop-middleware-chain",
        version: "1.0.0",
        model: { name: "mock" },
      },
      adapter: createSimpleLoopAdapter(),
      middleware: [lifecycleObserver],
      providers: [createSkillProvider([skill])],
      loopDetection: false,
    });

    // Warning fired at assembly
    expect(
      warnSpy.mock.calls.some(
        (args) => typeof args[0] === "string" && args[0].includes("nonexistent-tool"),
      ),
    ).toBe(true);

    // Middleware chain works normally
    const events = await collectEvents(runtime.run({ kind: "text", text: "test" }));
    expect(findDoneOutput(events)?.stopReason).toBe("completed");
    expect(hookOrder[0]).toBe("session_start");
    expect(hookOrder[hookOrder.length - 1]).toBe("session_end");
    expect(hookOrder).toContain("after_turn");

    await runtime.dispose();
  });
});

// ---------------------------------------------------------------------------
// Tests — createPiAdapter (real LLM, gated on E2E_TESTS + ANTHROPIC_API_KEY)
// ---------------------------------------------------------------------------

describeE2E("e2e: SkillRequiresExtension + createPiAdapter (real LLM)", () => {
  afterEach(() => {
    mock.restore();
  });

  test(
    "warns at assembly then runs real LLM with skill that has missing tool dep",
    async () => {
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

      const skill: SkillComponent = {
        name: "advanced-research",
        description: "Research that needs web-search",
        content: "# Advanced Research\nUse web-search to find information.",
        requires: { tools: ["web-search"] },
      };

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a concise assistant. Reply in one sentence.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: {
          name: "pi-skill-requires-test",
          version: "0.1.0",
          model: { name: "claude-haiku-4-5" },
        },
        adapter,
        providers: [createToolProvider([MULTIPLY_TOOL]), createSkillProvider([skill])],
        loopDetection: false,
      });

      // Verify warning at assembly
      const skillWarns = warnSpy.mock.calls.filter(
        (args) =>
          typeof args[0] === "string" &&
          args[0].includes("advanced-research") &&
          args[0].includes("web-search"),
      );
      expect(skillWarns.length).toBe(1);

      // Agent runs with real LLM despite missing skill dep
      expect(runtime.agent.state).toBe("created");
      const events = await collectEvents(runtime.run({ kind: "text", text: "Say: hello world" }));

      expect(runtime.agent.state).toBe("terminated");
      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");
      expect(output?.metrics.inputTokens).toBeGreaterThan(0);

      const text = extractText(events);
      expect(text.length).toBeGreaterThan(0);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "no warning when skill requires are satisfied, LLM uses the tool",
    async () => {
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

      // let justified: capture tool call metadata
      let toolCallObserved = false;
      let observedToolId: string | undefined;

      const toolObserver: KoiMiddleware = {
        name: "tool-observer",
        describeCapabilities: () => undefined,
        wrapToolCall: async (
          _ctx: unknown,
          request: ToolRequest,
          next: (r: ToolRequest) => Promise<ToolResponse>,
        ) => {
          toolCallObserved = true;
          observedToolId = request.toolId;
          return next(request);
        },
      };

      const skill: SkillComponent = {
        name: "math-assistant",
        description: "Math assistant that uses multiply tool",
        content: "# Math Assistant\nUse multiply for multiplication.",
        requires: { tools: ["multiply"] },
      };

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You MUST use the multiply tool for multiplication. Never compute in your head.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: {
          name: "pi-skill-satisfied-test",
          version: "0.1.0",
          model: { name: "claude-haiku-4-5" },
        },
        adapter,
        middleware: [toolObserver],
        providers: [createToolProvider([MULTIPLY_TOOL]), createSkillProvider([skill])],
        loopDetection: false,
      });

      // No skill-requires warnings
      const skillWarns = warnSpy.mock.calls.filter(
        (args) => typeof args[0] === "string" && args[0].includes("requires tool"),
      );
      expect(skillWarns.length).toBe(0);

      // Skill is attached (requires propagation proved by zero warns above)
      expect(runtime.agent.component(skillToken("math-assistant"))).toBeDefined();

      // LLM calls the tool through the full middleware chain
      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use the multiply tool to compute 13 * 17. Tell me the result.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output?.stopReason).toBe("completed");
      expect(toolCallObserved).toBe(true);
      expect(observedToolId).toBe("multiply");

      const text = extractText(events);
      expect(text).toContain("221");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "full stack: multiple skills + tools + middleware + real LLM",
    async () => {
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
      const toolCalls: string[] = [];

      const toolLogger: KoiMiddleware = {
        name: "tool-logger",
        describeCapabilities: () => undefined,
        wrapToolCall: async (
          _ctx: unknown,
          request: ToolRequest,
          next: (r: ToolRequest) => Promise<ToolResponse>,
        ) => {
          toolCalls.push(request.toolId);
          return next(request);
        },
      };

      const satisfiedSkill: SkillComponent = {
        name: "weather-skill",
        description: "Weather reporter",
        content: "# Weather\nUse get_weather.",
        requires: { tools: ["get_weather"] },
      };

      const partialSkill: SkillComponent = {
        name: "full-stack-skill",
        description: "Full stack developer",
        content: "# Full Stack\nUse multiply and code-runner.",
        requires: { tools: ["multiply", "code-runner"] },
      };

      const noRequiresSkill: SkillComponent = {
        name: "greeting-skill",
        description: "Just greets people",
        content: "# Greeting\nSay hello nicely.",
      };

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You have access to multiply and get_weather tools. Use them when asked.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: {
          name: "pi-full-stack-skills",
          version: "0.1.0",
          model: { name: "claude-haiku-4-5" },
        },
        adapter,
        middleware: [toolLogger],
        providers: [
          createToolProvider([MULTIPLY_TOOL, GET_WEATHER_TOOL]),
          createSkillProvider([satisfiedSkill, partialSkill, noRequiresSkill]),
        ],
        loopDetection: false,
      });

      // Only "code-runner" should produce a warning (from full-stack-skill)
      const skillWarns = warnSpy.mock.calls.filter(
        (args) => typeof args[0] === "string" && args[0].includes("requires tool"),
      );
      expect(skillWarns.length).toBe(1);
      expect(skillWarns[0]?.[0] as string).toContain("full-stack-skill");
      expect(skillWarns[0]?.[0] as string).toContain("code-runner");

      // All skills are attached
      expect(runtime.agent.component(skillToken("weather-skill"))).toBeDefined();
      expect(runtime.agent.component(skillToken("full-stack-skill"))).toBeDefined();
      expect(runtime.agent.component(skillToken("greeting-skill"))).toBeDefined();

      // Real LLM interaction with tool use
      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use get_weather for Tokyo, then use multiply to compute 6 * 7. Report both results.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");
      expect(output?.metrics.inputTokens).toBeGreaterThan(0);

      // At least one tool was called
      expect(toolCalls.length).toBeGreaterThanOrEqual(1);

      const text = extractText(events);
      // Should contain weather info and/or multiplication result
      const hasWeather = text.includes("22") || text.includes("sunny") || text.includes("Tokyo");
      const hasMath = text.includes("42");
      expect(hasWeather || hasMath).toBe(true);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );
});
