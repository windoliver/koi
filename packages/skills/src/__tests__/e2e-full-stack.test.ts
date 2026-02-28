/**
 * E2E: @koi/skills through the full createKoi + createPiAdapter runtime.
 *
 * Validates the complete skills pipeline with real LLM calls:
 *   1. createSkillComponentProvider loads SKILL.md fixtures from filesystem
 *   2. Skills attach as SkillComponent on the agent entity via skillToken()
 *   3. Skills are queryable via agent.query("skill:") and agent.component()
 *   4. Skills coexist with tools — tool calls route through middleware chain
 *   5. Partial success: invalid skills are skipped, valid ones load
 *   6. Deterministic (createLoopAdapter) tests for fast, reliable verification
 *   7. Real LLM (createPiAdapter) tests for full-stack validation
 *
 * Run:
 *   E2E_TESTS=1 bun test src/__tests__/e2e-full-stack.test.ts
 */

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { resolve } from "node:path";
import type {
  AgentManifest,
  ComponentProvider,
  EngineEvent,
  EngineOutput,
  KoiMiddleware,
  SkillComponent,
  SkillMetadata,
  Tool,
  ToolRequest,
  ToolResponse,
} from "@koi/core";
import { skillToken, toolToken } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import { createPiAdapter } from "@koi/engine-pi";
import { createSkillComponentProvider } from "../provider.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const describeE2E = HAS_KEY && E2E_OPTED_IN ? describe : describe.skip;

const TIMEOUT_MS = 120_000;
const E2E_MODEL = "anthropic:claude-haiku-4-5-20251001";
const FIXTURES = resolve(import.meta.dir, "../../fixtures");

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

function testManifest(overrides?: Partial<AgentManifest>): AgentManifest {
  return {
    name: "E2E Skills Agent",
    version: "0.1.0",
    model: { name: "claude-haiku-4-5" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const MULTIPLY_TOOL: Tool = {
  descriptor: {
    name: "multiply",
    description: "Multiplies two numbers together and returns the product.",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "number", description: "First number" },
        b: { type: "number", description: "Second number" },
      },
      required: ["a", "b"],
    },
  },
  trustTier: "sandbox",
  execute: async (input: Readonly<Record<string, unknown>>) => {
    const a = Number(input.a ?? 0);
    const b = Number(input.b ?? 0);
    return String(a * b);
  },
};

/** ComponentProvider that registers tools on the agent entity. */
function createToolProvider(tools: readonly Tool[]): ComponentProvider {
  return {
    name: "e2e-tool-provider",
    attach: async () => {
      const _tokenKey: string = toolToken(tools[0]?.descriptor.name ?? "");
      return new Map(
        tools.map((t) => {
          const key: string = toolToken(t.descriptor.name);
          return [key, t];
        }),
      );
    },
  };
}

/** Creates a deterministic loop adapter (no LLM call). */
function createSimpleLoopAdapter() {
  return createLoopAdapter({
    modelCall: async () => ({
      content: "Mock response — skills loaded successfully.",
      model: "mock",
      usage: { inputTokens: 10, outputTokens: 20 },
    }),
  });
}

// ---------------------------------------------------------------------------
// Test 1: Deterministic (createLoopAdapter) — fast, reliable
// ---------------------------------------------------------------------------

describe("e2e: @koi/skills + createLoopAdapter (deterministic)", () => {
  afterEach(() => {
    mock.restore();
  });

  test("skills provider attaches filesystem skills to agent entity", async () => {
    const skillProvider = createSkillComponentProvider({
      skills: [
        { name: "code-review", path: "./valid-skill" },
        { name: "minimal-skill", path: "./minimal-skill" },
      ],
      basePath: FIXTURES,
    });

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: createSimpleLoopAdapter(),
      providers: [skillProvider],
      loopDetection: false,
    });

    expect(runtime.agent.state).toBe("created");

    // Verify skills are queryable on the agent entity
    const allSkills = runtime.agent.query<SkillMetadata>("skill:");
    expect(allSkills.size).toBe(2);

    // Verify individual skills by token
    const codeReview = runtime.agent.component(skillToken("code-review"));
    expect(codeReview).toBeDefined();
    expect((codeReview as SkillComponent).name).toBe("code-review");
    expect((codeReview as SkillComponent).description).toContain("Reviews code");
    expect((codeReview as SkillComponent).content).toContain("# Code Review Skill");

    const minimal = runtime.agent.component(skillToken("minimal"));
    expect(minimal).toBeDefined();
    expect((minimal as SkillComponent).name).toBe("minimal");

    // Agent runs fine with skills attached
    const events = await collectEvents(runtime.run({ kind: "text", text: "hello" }));
    const output = findDoneOutput(events);
    expect(output?.stopReason).toBe("completed");
    expect(runtime.agent.state).toBe("terminated");

    await runtime.dispose();
  });

  test("skills coexist with tools on the same agent", async () => {
    const skillProvider = createSkillComponentProvider({
      skills: [{ name: "code-review", path: "./valid-skill" }],
      basePath: FIXTURES,
    });

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: createSimpleLoopAdapter(),
      providers: [createToolProvider([MULTIPLY_TOOL]), skillProvider],
      loopDetection: false,
    });

    // Both tools and skills are attached
    expect(runtime.agent.component(skillToken("code-review"))).toBeDefined();
    expect(runtime.agent.component(toolToken("multiply"))).toBeDefined();

    // Skill query returns only skills, not tools
    const skills = runtime.agent.query<SkillMetadata>("skill:");
    expect(skills.size).toBe(1);

    const events = await collectEvents(runtime.run({ kind: "text", text: "test" }));
    expect(findDoneOutput(events)?.stopReason).toBe("completed");

    await runtime.dispose();
  });

  test("partial success: invalid skills skipped, valid ones loaded", async () => {
    const _warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const skillProvider = createSkillComponentProvider({
      skills: [
        { name: "code-review", path: "./valid-skill" },
        { name: "bad-skill", path: "./invalid-name" },
        { name: "missing", path: "./nonexistent" },
        { name: "minimal-skill", path: "./minimal-skill" },
      ],
      basePath: FIXTURES,
    });

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: createSimpleLoopAdapter(),
      providers: [skillProvider],
      loopDetection: false,
    });

    // Valid skills attached
    expect(runtime.agent.component(skillToken("code-review"))).toBeDefined();
    expect(runtime.agent.component(skillToken("minimal"))).toBeDefined();

    // Invalid/missing skills NOT attached
    const allSkills = runtime.agent.query<SkillMetadata>("skill:");
    expect(allSkills.size).toBe(2);

    // Agent still works
    const events = await collectEvents(runtime.run({ kind: "text", text: "test" }));
    expect(findDoneOutput(events)?.stopReason).toBe("completed");

    await runtime.dispose();
  });

  test("skills loaded at metadata level produce description-only content", async () => {
    const skillProvider = createSkillComponentProvider({
      skills: [{ name: "minimal-skill", path: "./minimal-skill" }],
      basePath: FIXTURES,
      loadLevel: "metadata",
    });

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: createSimpleLoopAdapter(),
      providers: [skillProvider],
      loopDetection: false,
    });

    const skill = runtime.agent.component(skillToken("minimal")) as SkillComponent;
    expect(skill).toBeDefined();
    // At metadata level, content = description (no body)
    expect(skill.content).toBe("A minimal skill with only required fields.");

    await runtime.dispose();
  });

  test("middleware chain fires correctly with skills provider present", async () => {
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

    const skillProvider = createSkillComponentProvider({
      skills: [{ name: "code-review", path: "./valid-skill" }],
      basePath: FIXTURES,
    });

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: createSimpleLoopAdapter(),
      middleware: [lifecycleObserver],
      providers: [skillProvider],
      loopDetection: false,
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "test" }));
    expect(findDoneOutput(events)?.stopReason).toBe("completed");

    // Middleware lifecycle works with skills present
    expect(hookOrder[0]).toBe("session_start");
    expect(hookOrder[hookOrder.length - 1]).toBe("session_end");
    expect(hookOrder).toContain("after_turn");

    await runtime.dispose();
  });

  test("duplicate skill names: first-wins in provider, both attach attempts handled", async () => {
    const skillProvider = createSkillComponentProvider({
      skills: [
        { name: "code-review", path: "./valid-skill" },
        { name: "code-review", path: "./valid-skill" },
      ],
      basePath: FIXTURES,
    });

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: createSimpleLoopAdapter(),
      providers: [skillProvider],
      loopDetection: false,
    });

    // Only one skill:code-review attached (first-wins)
    const skills = runtime.agent.query<SkillMetadata>("skill:");
    expect(skills.size).toBe(1);
    expect(runtime.agent.component(skillToken("code-review"))).toBeDefined();

    await runtime.dispose();
  });

  test("manifest with skills field passes through to runtime", async () => {
    const manifest = testManifest({
      skills: [
        { name: "code-review", path: "./valid-skill" },
        { name: "deploy", path: "./minimal-skill" },
      ],
    });

    // Verify the manifest carries skills field
    expect(manifest.skills).toHaveLength(2);
    expect(manifest.skills?.[0]?.name).toBe("code-review");

    // Skills from manifest.skills need a provider to be loaded —
    // the manifest field is data, the provider does the work
    const skillProvider = createSkillComponentProvider({
      skills: manifest.skills ?? [],
      basePath: FIXTURES,
    });

    const runtime = await createKoi({
      manifest,
      adapter: createSimpleLoopAdapter(),
      providers: [skillProvider],
      loopDetection: false,
    });

    // Both skills are loaded and attached
    expect(runtime.agent.component(skillToken("code-review"))).toBeDefined();
    expect(runtime.agent.component(skillToken("minimal"))).toBeDefined();

    await runtime.dispose();
  });
});

// ---------------------------------------------------------------------------
// Test 2: Real LLM (createPiAdapter) — full-stack validation
// ---------------------------------------------------------------------------

describeE2E("e2e: @koi/skills + createPiAdapter (real LLM)", () => {
  afterEach(() => {
    mock.restore();
  });

  test(
    "skills attach and agent runs with real LLM response",
    async () => {
      const skillProvider = createSkillComponentProvider({
        skills: [{ name: "code-review", path: "./valid-skill" }],
        basePath: FIXTURES,
      });

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a concise assistant. Reply briefly.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        providers: [skillProvider],
        loopDetection: false,
      });

      expect(runtime.agent.state).toBe("created");

      // Verify skill is attached before running
      const skill = runtime.agent.component(skillToken("code-review")) as SkillComponent;
      expect(skill).toBeDefined();
      expect(skill.name).toBe("code-review");
      expect(skill.content).toContain("# Code Review Skill");

      // Real LLM call
      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Reply with exactly: pong" }),
      );

      expect(runtime.agent.state).toBe("terminated");
      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");
      expect(output?.metrics.inputTokens).toBeGreaterThan(0);
      expect(output?.metrics.outputTokens).toBeGreaterThan(0);

      const text = extractText(events);
      expect(text.toLowerCase()).toContain("pong");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "skills + tools coexist: LLM uses tool with skill attached",
    async () => {
      // let justified: capture tool call metadata for assertions
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

      const skillProvider = createSkillComponentProvider({
        skills: [{ name: "code-review", path: "./valid-skill" }],
        basePath: FIXTURES,
      });

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You MUST use the multiply tool for math questions. Never compute in your head.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [toolObserver],
        providers: [createToolProvider([MULTIPLY_TOOL]), skillProvider],
        loopDetection: false,
      });

      // Both skill and tool are attached
      expect(runtime.agent.component(skillToken("code-review"))).toBeDefined();
      expect(runtime.agent.component(toolToken("multiply"))).toBeDefined();

      // LLM calls tool through middleware chain
      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use the multiply tool to compute 7 * 8. Tell me the result.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output?.stopReason).toBe("completed");

      // Tool call went through middleware
      expect(toolCallObserved).toBe(true);
      expect(observedToolId).toBe("multiply");

      // Response should contain 56
      const text = extractText(events);
      expect(text).toContain("56");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "multiple skills loaded at body level with real LLM",
    async () => {
      const skillProvider = createSkillComponentProvider({
        skills: [
          { name: "code-review", path: "./valid-skill" },
          { name: "minimal-skill", path: "./minimal-skill" },
        ],
        basePath: FIXTURES,
        loadLevel: "body",
      });

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are concise. Reply in one sentence.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        providers: [skillProvider],
        loopDetection: false,
      });

      // Both skills attached
      const allSkills = runtime.agent.query<SkillMetadata>("skill:");
      expect(allSkills.size).toBe(2);

      const codeReview = runtime.agent.component(skillToken("code-review")) as SkillComponent;
      expect(codeReview.content).toContain("```javascript");

      const minimal = runtime.agent.component(skillToken("minimal")) as SkillComponent;
      expect(minimal.content).toBe("Minimal body.");

      // Real LLM interaction
      const events = await collectEvents(runtime.run({ kind: "text", text: "Say: hello world" }));

      const output = findDoneOutput(events);
      expect(output?.stopReason).toBe("completed");
      expect(extractText(events).length).toBeGreaterThan(0);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "partial success: invalid skills skipped, valid ones work with real LLM",
    async () => {
      const _warnSpy = spyOn(console, "warn").mockImplementation(() => {});

      const skillProvider = createSkillComponentProvider({
        skills: [
          { name: "code-review", path: "./valid-skill" },
          { name: "bad-skill", path: "./invalid-name" },
          { name: "no-fm", path: "./no-frontmatter" },
        ],
        basePath: FIXTURES,
      });

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Reply with one word.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        providers: [createToolProvider([MULTIPLY_TOOL]), skillProvider],
        loopDetection: false,
      });

      // Valid skill attached, invalid ones skipped
      expect(runtime.agent.component(skillToken("code-review"))).toBeDefined();
      const allSkills = runtime.agent.query<SkillMetadata>("skill:");
      expect(allSkills.size).toBe(1);

      // Agent still works with real LLM
      const events = await collectEvents(runtime.run({ kind: "text", text: "Say: OK" }));

      const output = findDoneOutput(events);
      expect(output?.stopReason).toBe("completed");
      expect(output?.metrics.inputTokens).toBeGreaterThan(0);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "full stack: manifest.skills + provider + tools + middleware + real LLM",
    async () => {
      const toolCalls: string[] = [];
      const hookOrder: string[] = [];

      const fullObserver: KoiMiddleware = {
        name: "full-observer",
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
        wrapToolCall: async (
          _ctx: unknown,
          request: ToolRequest,
          next: (r: ToolRequest) => Promise<ToolResponse>,
        ) => {
          toolCalls.push(request.toolId);
          return next(request);
        },
      };

      // Use manifest.skills field to configure
      const manifest = testManifest({
        skills: [
          { name: "code-review", path: "./valid-skill" },
          { name: "minimal-skill", path: "./minimal-skill" },
        ],
      });

      const skillProvider = createSkillComponentProvider({
        skills: manifest.skills ?? [],
        basePath: FIXTURES,
      });

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You have a multiply tool. Use it when asked to multiply. Be concise.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest,
        adapter,
        middleware: [fullObserver],
        providers: [createToolProvider([MULTIPLY_TOOL]), skillProvider],
        loopDetection: false,
      });

      // Skills + tools all attached
      expect(runtime.agent.component(skillToken("code-review"))).toBeDefined();
      expect(runtime.agent.component(skillToken("minimal"))).toBeDefined();
      expect(runtime.agent.component(toolToken("multiply"))).toBeDefined();

      const allSkills = runtime.agent.query<SkillMetadata>("skill:");
      expect(allSkills.size).toBe(2);

      // Real LLM interaction with tool use
      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use the multiply tool to compute 11 * 13. Tell me the result.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");
      expect(output?.metrics.inputTokens).toBeGreaterThan(0);

      // Tool call through middleware
      expect(toolCalls.length).toBeGreaterThanOrEqual(1);
      expect(toolCalls).toContain("multiply");

      // Response contains 143
      const text = extractText(events);
      expect(text).toContain("143");

      // Lifecycle hooks fired correctly
      expect(hookOrder[0]).toBe("session_start");
      expect(hookOrder[hookOrder.length - 1]).toBe("session_end");
      expect(hookOrder).toContain("after_turn");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );
});
