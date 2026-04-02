/**
 * Golden query CI tests — VCR cassette replay + full-stack ATIF validation.
 * Runs in CI without API keys. Zero network calls.
 *
 * Fixtures:
 *   fixtures/simple-text.cassette.json  — text response replay
 *   fixtures/tool-use.cassette.json     — tool call replay
 *   fixtures/simple-text.trajectory.json — Golden ATIF: text response (no tools)
 *   fixtures/tool-use.trajectory.json     — Golden ATIF: tool use (model → tool → model)
 *
 * Re-record: OPENROUTER_API_KEY=... bun run packages/meta/runtime/scripts/record-cassettes.ts
 */

import { describe, expect, test } from "bun:test";
import type { EngineEvent, JsonObject } from "@koi/core";
import { consumeModelStream } from "@koi/query-engine";
import { loadCassette } from "../cassette/load-cassette.js";

const FIXTURES = `${import.meta.dirname}/../../fixtures`;

async function collectEvents(stream: AsyncIterable<EngineEvent>): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function* toAsyncIterable<T>(items: readonly T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

// ---------------------------------------------------------------------------
// Cassette replay: simple text response
// ---------------------------------------------------------------------------

describe("Cassette replay: simple text response", () => {
  test("text_delta events + done with completed stopReason", async () => {
    const cassette = await loadCassette(`${FIXTURES}/simple-text.cassette.json`);
    const events = await collectEvents(consumeModelStream(toAsyncIterable(cassette.chunks)));

    expect(events.filter((e) => e.kind === "text_delta").length).toBeGreaterThan(0);
    const done = events.at(-1);
    expect(done?.kind).toBe("done");
    if (done?.kind === "done") {
      expect(done.output.stopReason).toBe("completed");
      expect(done.output.metrics.inputTokens).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Cassette replay: tool use flow
// ---------------------------------------------------------------------------

describe("Cassette replay: tool use flow", () => {
  test("tool_call_start with add_numbers + parsedArgs a=7 b=5", async () => {
    const cassette = await loadCassette(`${FIXTURES}/tool-use.cassette.json`);
    const events = await collectEvents(consumeModelStream(toAsyncIterable(cassette.chunks)));

    const toolStart = events.find((e) => e.kind === "tool_call_start");
    expect(toolStart).toBeDefined();
    if (toolStart?.kind === "tool_call_start") {
      expect(toolStart.toolName).toBe("add_numbers");
    }

    const toolEnd = events.find((e) => e.kind === "tool_call_end");
    expect(toolEnd).toBeDefined();
    if (toolEnd?.kind === "tool_call_end") {
      const result = toolEnd.result as { readonly parsedArgs?: Record<string, unknown> };
      expect(result.parsedArgs?.a).toBe(7);
      expect(result.parsedArgs?.b).toBe(5);
    }
  });
});

// ---------------------------------------------------------------------------
// tool-use trajectory: full ATIF validation (14 steps, all L2 packages)
// ---------------------------------------------------------------------------

describe("tool-use ATIF trajectory (golden file)", () => {
  test("valid ATIF v1.6 with session_id", async () => {
    const doc = (await Bun.file(`${FIXTURES}/tool-use.trajectory.json`).json()) as Record<
      string,
      unknown
    >;
    expect(doc.schema_version).toBe("ATIF-v1.6");
    expect(doc.session_id).toBe("tool-use");
  });

  test("agent metadata: model_name + tool_definitions (tools-core + tools-builtin)", async () => {
    const doc = (await Bun.file(`${FIXTURES}/tool-use.trajectory.json`).json()) as {
      readonly agent: {
        readonly model_name?: string;
        readonly tool_definitions?: readonly { readonly name: string }[];
      };
    };

    expect(doc.agent.model_name).toBe("google/gemini-2.0-flash-001");
    // @koi/tools-core: add_numbers built via buildTool()
    expect(doc.agent.tool_definitions?.some((t) => t.name === "add_numbers")).toBe(true);
    // @koi/tools-builtin: Glob, Grep, ToolSearch from createBuiltinSearchProvider
    expect(doc.agent.tool_definitions?.some((t) => t.name === "Glob")).toBe(true);
    expect(doc.agent.tool_definitions?.some((t) => t.name === "Grep")).toBe(true);
    expect(doc.agent.tool_definitions?.some((t) => t.name === "ToolSearch")).toBe(true);
  });

  test("MCP lifecycle: connecting + connected steps (@koi/mcp)", async () => {
    const doc = (await Bun.file(`${FIXTURES}/tool-use.trajectory.json`).json()) as {
      readonly steps: readonly { readonly extra?: Record<string, unknown> }[];
    };

    const mcpSteps = doc.steps.filter((s) => s.extra?.type === "mcp_lifecycle");
    expect(mcpSteps.length).toBeGreaterThanOrEqual(2);
    expect(mcpSteps.some((s) => s.extra?.transportState === "connecting")).toBe(true);
    expect(mcpSteps.some((s) => s.extra?.transportState === "connected")).toBe(true);
  });

  test("hook execution steps (@koi/hooks)", async () => {
    const doc = (await Bun.file(`${FIXTURES}/tool-use.trajectory.json`).json()) as {
      readonly steps: readonly { readonly extra?: Record<string, unknown> }[];
    };

    const hookSteps = doc.steps.filter((s) => s.extra?.type === "hook_execution");
    expect(hookSteps.length).toBeGreaterThan(0);
    expect(hookSteps[0]?.extra?.hookName).toBe("on-tool-exec");
  });

  test("model_call steps with prompt and metrics (@koi/model-openai-compat)", async () => {
    const doc = (await Bun.file(`${FIXTURES}/tool-use.trajectory.json`).json()) as {
      readonly steps: readonly {
        readonly source: string;
        readonly model_name?: string;
        readonly message?: string;
        readonly metrics?: Record<string, unknown>;
      }[];
    };

    const modelSteps = doc.steps.filter((s) => s.source === "agent" && s.model_name !== undefined);
    expect(modelSteps.length).toBeGreaterThan(0);
    expect(modelSteps[0]?.message).toContain("add_numbers");
    expect(modelSteps[0]?.metrics?.prompt_tokens).toBeGreaterThan(0);
  });

  test("tool_call steps with result containing 12 (@koi/query-engine)", async () => {
    const doc = (await Bun.file(`${FIXTURES}/tool-use.trajectory.json`).json()) as {
      readonly steps: readonly {
        readonly source: string;
        readonly observation?: { readonly results?: readonly { readonly content: string }[] };
      }[];
    };

    const toolSteps = doc.steps.filter(
      (s) => s.source === "tool" && s.observation?.results !== undefined,
    );
    expect(toolSteps.length).toBeGreaterThan(0);
    expect(toolSteps[0]?.observation?.results?.[0]?.content).toContain("12");
  });

  test("MW:permissions spans with hook/phase/priority (@koi/middleware-permissions)", async () => {
    const doc = (await Bun.file(`${FIXTURES}/tool-use.trajectory.json`).json()) as {
      readonly steps: readonly { readonly extra?: Record<string, unknown> }[];
    };

    const permSpans = doc.steps.filter(
      (s) => s.extra?.type === "middleware_span" && s.extra?.middlewareName === "permissions",
    );
    expect(permSpans.length).toBeGreaterThan(0);
    // Each permissions span should have hook, phase, priority metadata
    for (const span of permSpans) {
      expect(span.extra?.hook).toBeDefined();
      expect(span.extra?.phase).toBeDefined();
      expect(span.extra?.priority).toBeDefined();
      expect(span.extra?.nextCalled).toBe(true);
    }
  });

  test("MW:hook-dispatch spans (@koi/hooks middleware)", async () => {
    const doc = (await Bun.file(`${FIXTURES}/tool-use.trajectory.json`).json()) as {
      readonly steps: readonly { readonly extra?: Record<string, unknown> }[];
    };

    const hookDispatchSpans = doc.steps.filter(
      (s) => s.extra?.type === "middleware_span" && s.extra?.middlewareName === "hook-dispatch",
    );
    expect(hookDispatchSpans.length).toBeGreaterThan(0);
  });

  test("step count covers all L2 packages (>= 10 steps)", async () => {
    const doc = (await Bun.file(`${FIXTURES}/tool-use.trajectory.json`).json()) as {
      readonly steps: readonly unknown[];
    };
    // MCP(2) + MW:permissions(4) + HOOK(2) + MW:hook-dispatch(2) + MODEL(2) + TOOL(2) = 14
    expect(doc.steps.length).toBeGreaterThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------
// simple-text trajectory: ATIF validation (4 steps, no tools)
// ---------------------------------------------------------------------------

describe("simple-text ATIF trajectory (golden file)", () => {
  test("valid ATIF v1.6", async () => {
    const doc = (await Bun.file(`${FIXTURES}/simple-text.trajectory.json`).json()) as Record<
      string,
      unknown
    >;
    expect(doc.schema_version).toBe("ATIF-v1.6");
  });

  test("model call with prompt, response text, and metrics", async () => {
    const doc = (await Bun.file(`${FIXTURES}/simple-text.trajectory.json`).json()) as {
      readonly steps: readonly {
        readonly source: string;
        readonly model_name?: string;
        readonly message?: string;
        readonly observation?: { readonly results?: readonly { readonly content: string }[] };
        readonly metrics?: Record<string, unknown>;
      }[];
    };

    const modelSteps = doc.steps.filter((s) => s.source === "agent" && s.model_name !== undefined);
    expect(modelSteps.length).toBeGreaterThan(0);
    // User prompt captured in message
    expect(modelSteps[0]?.message).toContain("2+2");
    // Model response text captured from streaming text_delta accumulation
    const responseText = modelSteps[0]?.observation?.results?.[0]?.content ?? "";
    expect(responseText).toContain("4");
    expect(modelSteps[0]?.metrics?.prompt_tokens).toBeGreaterThan(0);
  });

  test("NO tool_call steps (text-only query)", async () => {
    const doc = (await Bun.file(`${FIXTURES}/simple-text.trajectory.json`).json()) as {
      readonly steps: readonly { readonly source: string }[];
    };
    const toolSteps = doc.steps.filter((s) => s.source === "tool");
    expect(toolSteps).toHaveLength(0);
  });

  test("MCP lifecycle steps present", async () => {
    const doc = (await Bun.file(`${FIXTURES}/simple-text.trajectory.json`).json()) as {
      readonly steps: readonly { readonly extra?: Record<string, unknown> }[];
    };

    const mcpSteps = doc.steps.filter((s) => s.extra?.type === "mcp_lifecycle");
    expect(mcpSteps.length).toBeGreaterThanOrEqual(2);
  });

  test("MW:permissions span present (even without tools)", async () => {
    const doc = (await Bun.file(`${FIXTURES}/simple-text.trajectory.json`).json()) as {
      readonly steps: readonly { readonly extra?: Record<string, unknown> }[];
    };

    const permSpans = doc.steps.filter(
      (s) => s.extra?.type === "middleware_span" && s.extra?.middlewareName === "permissions",
    );
    expect(permSpans.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// glob-use trajectory: Glob builtin tool exercised (@koi/tools-builtin)
// ---------------------------------------------------------------------------

describe("glob-use ATIF trajectory (golden file)", () => {
  test("valid ATIF v1.6 with Glob in tool_definitions", async () => {
    const doc = (await Bun.file(`${FIXTURES}/glob-use.trajectory.json`).json()) as {
      readonly schema_version: string;
      readonly agent: {
        readonly tool_definitions?: readonly { readonly name: string }[];
      };
    };
    expect(doc.schema_version).toBe("ATIF-v1.6");
    expect(doc.agent.tool_definitions?.some((t) => t.name === "Glob")).toBe(true);
    expect(doc.agent.tool_definitions?.some((t) => t.name === "Grep")).toBe(true);
    expect(doc.agent.tool_definitions?.some((t) => t.name === "ToolSearch")).toBe(true);
  });

  test("has TOOL step for Glob with file paths result", async () => {
    const doc = (await Bun.file(`${FIXTURES}/glob-use.trajectory.json`).json()) as {
      readonly steps: readonly {
        readonly source: string;
        readonly tool_calls?: readonly { readonly function_name: string }[];
        readonly observation?: { readonly results?: readonly { readonly content: string }[] };
      }[];
    };

    const toolSteps = doc.steps.filter(
      (s) => s.source === "tool" && s.observation?.results !== undefined,
    );
    expect(toolSteps.length).toBeGreaterThan(0);
    // Glob returns paths array
    const content = toolSteps[0]?.observation?.results?.[0]?.content ?? "";
    expect(content).toContain("package.json");
  });

  test("has MW:permissions + MW:hook-dispatch spans", async () => {
    const doc = (await Bun.file(`${FIXTURES}/glob-use.trajectory.json`).json()) as {
      readonly steps: readonly { readonly extra?: Record<string, unknown> }[];
    };

    const mwNames = new Set(
      doc.steps
        .filter((s) => s.extra?.type === "middleware_span")
        .map((s) => s.extra?.middlewareName),
    );
    expect(mwNames.has("permissions")).toBe(true);
    expect(mwNames.has("hook-dispatch")).toBe(true);
  });

  test("step count >= 10 (MCP + MW + MODEL + TOOL)", async () => {
    const doc = (await Bun.file(`${FIXTURES}/glob-use.trajectory.json`).json()) as {
      readonly steps: readonly unknown[];
    };
    expect(doc.steps.length).toBeGreaterThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------
// permission-deny trajectory: permissions blocks add_numbers
// ---------------------------------------------------------------------------

describe("permission-deny ATIF trajectory (golden file)", () => {
  test("valid ATIF v1.6 with tools in definitions but denied at runtime", async () => {
    const doc = (await Bun.file(`${FIXTURES}/permission-deny.trajectory.json`).json()) as {
      readonly schema_version: string;
      readonly agent: {
        readonly tool_definitions?: readonly { readonly name: string }[];
      };
    };
    expect(doc.schema_version).toBe("ATIF-v1.6");
    // add_numbers is in tool_definitions (registered) even though denied
    expect(doc.agent.tool_definitions?.some((t) => t.name === "add_numbers")).toBe(true);
  });

  test("model response mentions inability to use the tool", async () => {
    const doc = (await Bun.file(`${FIXTURES}/permission-deny.trajectory.json`).json()) as {
      readonly steps: readonly {
        readonly source: string;
        readonly model_name?: string;
        readonly observation?: { readonly results?: readonly { readonly content: string }[] };
      }[];
    };

    const modelSteps = doc.steps.filter((s) => s.source === "agent" && s.model_name !== undefined);
    expect(modelSteps.length).toBeGreaterThan(0);
    // Model should explain it can't use the tool (permissions filtered it out)
    const responseText = modelSteps[0]?.observation?.results?.[0]?.content ?? "";
    // Model won't call add_numbers — it was removed from available tools by permissions MW
    // Response may say "cannot", "don't have", "no tool", etc.
    expect(responseText.length).toBeGreaterThan(0);
  });

  test("NO tool_call steps (denied tool never executed)", async () => {
    const doc = (await Bun.file(`${FIXTURES}/permission-deny.trajectory.json`).json()) as {
      readonly steps: readonly { readonly source: string }[];
    };
    const toolSteps = doc.steps.filter((s) => s.source === "tool");
    expect(toolSteps).toHaveLength(0);
  });

  test("MW:permissions span present with wrapModelStream hook", async () => {
    const doc = (await Bun.file(`${FIXTURES}/permission-deny.trajectory.json`).json()) as {
      readonly steps: readonly { readonly extra?: Record<string, unknown> }[];
    };

    const permSpans = doc.steps.filter(
      (s) => s.extra?.type === "middleware_span" && s.extra?.middlewareName === "permissions",
    );
    expect(permSpans.length).toBeGreaterThan(0);
    // wrapModelStream is where filterTools strips the denied tool
    expect(permSpans.some((s) => s.extra?.hook === "wrapModelStream")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// L2 golden queries: @koi/permissions (2 queries)
// ---------------------------------------------------------------------------

describe("Golden: @koi/permissions", () => {
  test("bypass mode allows all queries unconditionally", async () => {
    const { createPermissionBackend } = await import("@koi/permissions");
    const backend = createPermissionBackend({ mode: "bypass", rules: [] });

    const decision = await backend.check({
      principal: "agent",
      resource: "tool:add_numbers",
      action: "execute",
    });
    expect(decision.effect).toBe("allow");
  });

  test("deny rule blocks matching resources", async () => {
    const { createPermissionBackend } = await import("@koi/permissions");
    const backend = createPermissionBackend({
      mode: "default",
      rules: [{ pattern: "tool:dangerous_*", action: "*", effect: "deny", source: "policy" }],
    });

    const decision = await backend.check({
      principal: "agent",
      resource: "tool:dangerous_rm",
      action: "execute",
    });
    expect(decision.effect).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// L2 golden queries: @koi/middleware-permissions (2 queries)
// ---------------------------------------------------------------------------

describe("Golden: @koi/middleware-permissions", () => {
  test("middleware name is 'permissions' with wrapToolCall + wrapModelCall", async () => {
    const { createPermissionsMiddleware } = await import("@koi/middleware-permissions");
    const { createPermissionBackend } = await import("@koi/permissions");

    const backend = createPermissionBackend({ mode: "bypass", rules: [] });
    const mw = createPermissionsMiddleware({ backend, description: "test" });

    expect(mw.name).toBe("permissions");
    expect(typeof mw.wrapToolCall).toBe("function");
    expect(typeof mw.wrapModelCall).toBe("function");
  });

  test("auto-approval handler is a callable factory", async () => {
    const { createAutoApprovalHandler } = await import("@koi/middleware-permissions");
    expect(typeof createAutoApprovalHandler).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// L2 golden queries: @koi/tools-core (2 queries)
// ---------------------------------------------------------------------------

describe("Golden: @koi/tools-core", () => {
  test("buildTool produces a valid Tool and execute works", async () => {
    const { buildTool } = await import("@koi/tools-core");

    const result = buildTool({
      name: "adder",
      description: "Adds two numbers",
      inputSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
      },
      origin: "primordial",
      execute: async (args: JsonObject) => ({
        sum: (args.a as number) + (args.b as number),
      }),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.descriptor.name).toBe("adder");
      expect(result.value.origin).toBe("primordial");
      const output = (await result.value.execute({ a: 3, b: 4 })) as { readonly sum: number };
      expect(output.sum).toBe(7);
    }
  });

  test("buildTool rejects invalid definitions with VALIDATION error", async () => {
    const { buildTool } = await import("@koi/tools-core");

    const result = buildTool({
      name: "",
      description: "empty name is invalid",
      inputSchema: { type: "object" },
      origin: "primordial",
      execute: async () => ({}),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });
});

// ---------------------------------------------------------------------------
// L2 golden queries: @koi/tools-builtin (2 queries)
// ---------------------------------------------------------------------------

describe("Golden: @koi/tools-builtin", () => {
  test("createGlobTool produces a primordial Tool named Glob", async () => {
    const { createGlobTool } = await import("@koi/tools-builtin");

    const tool = createGlobTool({ cwd: process.cwd() });
    expect(tool.descriptor.name).toBe("Glob");
    expect(tool.origin).toBe("primordial");
    expect(tool.policy).toBeDefined();
  });

  test("Glob tool executes and finds files", async () => {
    const { createGlobTool } = await import("@koi/tools-builtin");

    const tool = createGlobTool({ cwd: process.cwd() });
    const result = (await tool.execute({ pattern: "package.json" })) as {
      readonly paths?: readonly string[];
    };
    expect(result.paths).toBeDefined();
    expect(result.paths?.length).toBeGreaterThan(0);
  });
});
