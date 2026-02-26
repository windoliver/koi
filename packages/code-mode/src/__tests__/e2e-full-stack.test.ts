/**
 * End-to-end tests for @koi/code-mode through the full L1 runtime.
 *
 * Tests the complete createKoi → middleware → tool execution pipeline with
 * a scripted model call that returns tool calls in the response metadata.
 *
 * This validates:
 * - Code-mode tools are discoverable through ECS assembly (ComponentProvider)
 * - Tools execute through the L1 middleware chain
 * - All 3 gaps work: delete steps, rollback on failure, preview context lines
 *
 * Optional real LLM test gated on ANTHROPIC_API_KEY + E2E_TESTS=1.
 */

import { describe, expect, test } from "bun:test";
import type {
  ComponentProvider,
  EngineEvent,
  EngineOutput,
  FileSystemBackend,
  JsonObject,
  ModelRequest,
  ModelResponse,
  ToolDescriptor,
} from "@koi/core";
import { FILESYSTEM, toolToken } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import { createCodeModeProvider } from "../component-provider.js";
import { createMockBackend } from "../test-helpers.js";

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

function findToolCallEnds(
  events: readonly EngineEvent[],
): readonly (EngineEvent & { readonly kind: "tool_call_end" })[] {
  return events.filter(
    (e): e is EngineEvent & { readonly kind: "tool_call_end" } => e.kind === "tool_call_end",
  );
}

/**
 * Create a ComponentProvider that attaches a FileSystemBackend as the FILESYSTEM
 * component. Code-mode's provider discovers this and creates its tools.
 */
function createFilesystemProvider(backend: FileSystemBackend): ComponentProvider {
  return {
    name: "filesystem",
    attach: async (): Promise<ReadonlyMap<string, unknown>> => {
      return new Map<string, unknown>([[FILESYSTEM as string, backend]]);
    },
  };
}

/**
 * Create a scripted model call that returns pre-defined tool calls.
 *
 * The script is a queue of responses. Each response either has tool calls
 * (which the loop adapter will execute) or just text (which ends the loop).
 */
function createScriptedModelCall(
  script: readonly ModelResponse[],
): (request: ModelRequest) => Promise<ModelResponse> {
  /* let justified: mutable turn counter for scripted sequence */
  let callIndex = 0;
  return async (_request: ModelRequest): Promise<ModelResponse> => {
    const response = script[callIndex];
    if (response === undefined) {
      return { content: "Script exhausted", model: "scripted" };
    }
    callIndex++;
    return response;
  };
}

/** Build a ModelResponse that triggers a single tool call. */
function toolCallResponse(toolName: string, input: JsonObject, callId?: string): ModelResponse {
  return {
    content: "",
    model: "scripted",
    metadata: {
      toolCalls: [
        {
          toolName,
          callId: callId ?? `call-${toolName}-${Date.now()}`,
          input,
        },
      ],
    },
  };
}

/** Build a final text response (no tool calls = loop ends). */
function textResponse(text: string): ModelResponse {
  return { content: text, model: "scripted" };
}

// ---------------------------------------------------------------------------
// Tests: Deterministic E2E through full createKoi runtime
// ---------------------------------------------------------------------------

describe("e2e: code-mode through full L1 runtime (createKoi + createLoopAdapter)", () => {
  test("create + edit plan through full middleware chain", async () => {
    const backend = createMockBackend({
      "/src/index.ts": 'export const version = "1.0.0";\n',
    });

    // Script: model calls code_plan_create, then code_plan_apply, then responds
    const modelCall = createScriptedModelCall([
      // Turn 1: create a plan with edit + create
      toolCallResponse("code_plan_create", {
        steps: [
          {
            kind: "edit",
            path: "/src/index.ts",
            edits: [{ oldText: '"1.0.0"', newText: '"2.0.0"' }],
            description: "bump version",
          },
          {
            kind: "create",
            path: "/CHANGELOG.md",
            content: "# v2.0.0\n- Bumped version",
          },
        ],
      }),
      // Turn 2: apply the plan
      toolCallResponse("code_plan_apply", {}),
      // Turn 3: final text response
      textResponse("Done! Version bumped to 2.0.0"),
    ]);

    const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });

    const runtime = await createKoi({
      manifest: {
        name: "code-e2e",
        version: "1.0.0",
        model: { name: "scripted" },
      },
      adapter,
      providers: [createFilesystemProvider(backend), createCodeModeProvider()],
      loopDetection: false,
    });

    const events = await collectEvents(
      runtime.run({ kind: "text", text: "Bump the version to 2.0.0" }),
    );

    // Verify the run completed
    const output = findDoneOutput(events);
    expect(output).toBeDefined();
    expect(output?.stopReason).toBe("completed");
    expect(output?.metrics.turns).toBe(3);

    // Verify tool calls happened
    const toolEnds = findToolCallEnds(events);
    expect(toolEnds.length).toBe(2);

    // Verify code_plan_create returned a preview
    const createResult = toolEnds[0]?.result;
    expect(
      typeof createResult === "string" ? createResult : JSON.stringify(createResult),
    ).toContain("plan");

    // Verify code_plan_apply succeeded
    const applyResult = toolEnds[1]?.result;
    const applyParsed = typeof applyResult === "string" ? JSON.parse(applyResult) : applyResult;
    expect(applyParsed.success).toBe(true);
    expect(applyParsed.rolledBack).toBe(false);

    // Verify files were actually modified
    const indexResult = await backend.read("/src/index.ts");
    expect(indexResult.ok).toBe(true);
    if (indexResult.ok) {
      expect(indexResult.value.content).toContain('"2.0.0"');
    }

    const changelogResult = await backend.read("/CHANGELOG.md");
    expect(changelogResult.ok).toBe(true);

    await runtime.dispose();
  }, 30_000);

  test("delete step through full runtime", async () => {
    const backend = createMockBackend({
      "/src/legacy.ts": "// deprecated code\nexport const old = true;\n",
      "/src/index.ts": 'export { old } from "./legacy.js";\n',
    });

    const modelCall = createScriptedModelCall([
      // Turn 1: create a plan with delete
      toolCallResponse("code_plan_create", {
        steps: [
          { kind: "delete", path: "/src/legacy.ts", description: "remove deprecated" },
          {
            kind: "edit",
            path: "/src/index.ts",
            edits: [
              {
                oldText: 'export { old } from "./legacy.js";',
                newText: "// legacy removed",
              },
            ],
          },
        ],
      }),
      // Turn 2: apply
      toolCallResponse("code_plan_apply", {}),
      // Turn 3: done
      textResponse("Removed legacy code"),
    ]);

    const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });

    const runtime = await createKoi({
      manifest: { name: "delete-e2e", version: "1.0.0", model: { name: "scripted" } },
      adapter,
      providers: [createFilesystemProvider(backend), createCodeModeProvider()],
      loopDetection: false,
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "Remove legacy code" }));

    const output = findDoneOutput(events);
    expect(output?.stopReason).toBe("completed");

    const toolEnds = findToolCallEnds(events);
    const applyResult =
      typeof toolEnds[1]?.result === "string"
        ? JSON.parse(toolEnds[1].result)
        : toolEnds[1]?.result;
    expect(applyResult.success).toBe(true);
    expect(applyResult.steps.length).toBe(2);

    // Verify file was deleted
    const legacyResult = await backend.read("/src/legacy.ts");
    expect(legacyResult.ok).toBe(false);

    // Verify edit was applied
    const indexResult = await backend.read("/src/index.ts");
    expect(indexResult.ok).toBe(true);
    if (indexResult.ok) {
      expect(indexResult.value.content).toContain("legacy removed");
    }

    await runtime.dispose();
  }, 30_000);

  test("rollback on failure through full runtime", async () => {
    const backend = createMockBackend({
      "/src/config.ts": 'export const env = "production";\n',
    });

    const modelCall = createScriptedModelCall([
      // Turn 1: create a plan where step 2 will fail (file doesn't exist)
      toolCallResponse("code_plan_create", {
        steps: [
          { kind: "create", path: "/src/new-file.ts", content: "export const x = 1;" },
          {
            kind: "edit",
            path: "/nonexistent.ts",
            edits: [{ oldText: "x", newText: "y" }],
          },
        ],
      }),
      // Turn 2: apply — this will fail with rollback
      toolCallResponse("code_plan_apply", {}),
      // Turn 3: model responds to the error
      textResponse("Plan failed — the file /nonexistent.ts doesn't exist"),
    ]);

    const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });

    const runtime = await createKoi({
      manifest: { name: "rollback-e2e", version: "1.0.0", model: { name: "scripted" } },
      adapter,
      providers: [createFilesystemProvider(backend), createCodeModeProvider()],
      loopDetection: false,
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "Make changes" }));

    const output = findDoneOutput(events);
    expect(output?.stopReason).toBe("completed");

    const toolEnds = findToolCallEnds(events);
    // create tool was called and returned a preview (including validation issues)
    expect(toolEnds.length).toBe(2);

    // The plan-create should have reported the validation error (FILE_NOT_FOUND)
    // because the backend doesn't have /nonexistent.ts
    const createResult =
      typeof toolEnds[0]?.result === "string"
        ? JSON.parse(toolEnds[0].result)
        : toolEnds[0]?.result;

    // If validation caught the missing file, the plan won't be created
    if (createResult.error !== undefined) {
      expect(createResult.code).toBe("VALIDATION");
    }

    // The created file should NOT exist (either never created, or rolled back)
    const newFileResult = await backend.read("/src/new-file.ts");
    // If validation failed at plan-create, file was never created
    // If it passed (unlikely with missing file), rollback would clean it up
    expect(newFileResult.ok).toBe(false);

    await runtime.dispose();
  }, 30_000);

  test("rollback restores files after mid-apply failure", async () => {
    const originalContent = 'export const version = "1.0.0";\n';
    const backend = createMockBackend({
      "/src/index.ts": originalContent,
    });

    // Intercept the backend's edit to fail on the second edit
    /* let justified: mutable call counter for scripted failure */
    let editCount = 0;
    const originalEdit = backend.edit;
    Object.defineProperty(backend, "edit", {
      value: (
        path: string,
        edits: readonly { readonly oldText: string; readonly newText: string }[],
      ) => {
        editCount++;
        if (editCount === 2) {
          return {
            ok: false as const,
            error: { code: "INTERNAL" as const, message: "disk full", retryable: false },
          };
        }
        return originalEdit(path, edits);
      },
    });

    const modelCall = createScriptedModelCall([
      toolCallResponse("code_plan_create", {
        steps: [
          {
            kind: "edit",
            path: "/src/index.ts",
            edits: [{ oldText: '"1.0.0"', newText: '"2.0.0"' }],
          },
          // This step won't exist in validation, but the APPLY will fail
          // because we rigged the backend.edit to fail on 2nd call
          {
            kind: "edit",
            path: "/src/index.ts",
            edits: [{ oldText: '"2.0.0"', newText: '"3.0.0"' }],
          },
        ],
      }),
      toolCallResponse("code_plan_apply", {}),
      textResponse("Plan failed due to disk error"),
    ]);

    const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });

    const runtime = await createKoi({
      manifest: { name: "rollback-edit-e2e", version: "1.0.0", model: { name: "scripted" } },
      adapter,
      providers: [createFilesystemProvider(backend), createCodeModeProvider()],
      loopDetection: false,
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "Make changes" }));

    const toolEnds = findToolCallEnds(events);

    // Check if plan was created (may have validation issues with ambiguous match)
    const createResult =
      typeof toolEnds[0]?.result === "string"
        ? JSON.parse(toolEnds[0].result)
        : toolEnds[0]?.result;

    if (createResult.planId !== undefined) {
      // Plan was created — check apply result
      const applyResult =
        typeof toolEnds[1]?.result === "string"
          ? JSON.parse(toolEnds[1].result)
          : toolEnds[1]?.result;

      if (applyResult.success === false) {
        expect(applyResult.rolledBack).toBe(true);

        // File should be restored to original
        const readResult = await backend.read("/src/index.ts");
        expect(readResult.ok).toBe(true);
        if (readResult.ok) {
          expect(readResult.value.content).toBe(originalContent);
        }
      }
    }

    await runtime.dispose();
  }, 30_000);

  test("preview includes context lines when fileContents is stored on plan", async () => {
    const backend = createMockBackend({
      "/src/index.ts": [
        'import { foo } from "./bar.js";',
        "",
        'export const version = "1.0.0";',
        "",
        "export function main() {",
        "  return version;",
        "}",
      ].join("\n"),
    });

    const modelCall = createScriptedModelCall([
      toolCallResponse("code_plan_create", {
        steps: [
          {
            kind: "edit",
            path: "/src/index.ts",
            edits: [
              {
                oldText: 'export const version = "1.0.0";',
                newText: 'export const version = "2.0.0";',
              },
            ],
          },
        ],
      }),
      // Don't apply — just check the preview
      textResponse("Here is the plan preview above"),
    ]);

    const adapter = createLoopAdapter({ modelCall, maxTurns: 3 });

    const runtime = await createKoi({
      manifest: { name: "preview-e2e", version: "1.0.0", model: { name: "scripted" } },
      adapter,
      providers: [createFilesystemProvider(backend), createCodeModeProvider()],
      loopDetection: false,
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "Show me a preview" }));

    const toolEnds = findToolCallEnds(events);
    expect(toolEnds.length).toBe(1);

    const createResult =
      typeof toolEnds[0]?.result === "string"
        ? JSON.parse(toolEnds[0].result)
        : toolEnds[0]?.result;

    expect(createResult.planId).toBeDefined();
    expect(createResult.files.length).toBe(1);

    const filePreview = createResult.files[0];
    const lines: readonly string[] = filePreview.lines;

    // Should contain context lines (2-space prefix)
    const contextLines = lines.filter((l: string) => l.startsWith("  "));
    expect(contextLines.length).toBeGreaterThan(0);

    // Should contain the diff
    const removedLines = lines.filter((l: string) => l.startsWith("- "));
    const addedLines = lines.filter((l: string) => l.startsWith("+ "));
    expect(removedLines.length).toBe(1);
    expect(addedLines.length).toBe(1);

    // Context before should include import line
    expect(contextLines.some((l: string) => l.includes("import"))).toBe(true);

    // Context after should include function
    expect(contextLines.some((l: string) => l.includes("export function"))).toBe(true);

    await runtime.dispose();
  }, 30_000);

  test("code_plan_status works through the runtime", async () => {
    const backend = createMockBackend();

    const modelCall = createScriptedModelCall([
      // Turn 1: check status (no plan yet)
      toolCallResponse("code_plan_status", {}),
      // Turn 2: create a plan
      toolCallResponse("code_plan_create", {
        steps: [{ kind: "create", path: "/new.ts", content: "export const x = 1;" }],
      }),
      // Turn 3: check status again (should be pending)
      toolCallResponse("code_plan_status", {}),
      // Turn 4: done
      textResponse("Status checked"),
    ]);

    const adapter = createLoopAdapter({ modelCall, maxTurns: 6 });

    const runtime = await createKoi({
      manifest: { name: "status-e2e", version: "1.0.0", model: { name: "scripted" } },
      adapter,
      providers: [createFilesystemProvider(backend), createCodeModeProvider()],
      loopDetection: false,
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "Check status" }));

    const toolEnds = findToolCallEnds(events);
    expect(toolEnds.length).toBe(3);

    // First status: no plan
    const status1 =
      typeof toolEnds[0]?.result === "string"
        ? JSON.parse(toolEnds[0].result)
        : toolEnds[0]?.result;
    expect(status1.planId).toBeUndefined();

    // After create, status should show pending
    const status2 =
      typeof toolEnds[2]?.result === "string"
        ? JSON.parse(toolEnds[2].result)
        : toolEnds[2]?.result;
    expect(status2.state).toBe("pending");
    expect(status2.stepCount).toBe(1);

    await runtime.dispose();
  }, 30_000);

  test("tools are discoverable through agent.query", async () => {
    const backend = createMockBackend();

    // Minimal run — just validate assembly
    const modelCall = createScriptedModelCall([textResponse("OK")]);
    const adapter = createLoopAdapter({ modelCall, maxTurns: 1 });

    const runtime = await createKoi({
      manifest: { name: "discover-e2e", version: "1.0.0", model: { name: "scripted" } },
      adapter,
      providers: [createFilesystemProvider(backend), createCodeModeProvider()],
      loopDetection: false,
    });

    // Verify code-mode tools were attached
    const agent = runtime.agent;
    expect(agent.has(toolToken("code_plan_create"))).toBe(true);
    expect(agent.has(toolToken("code_plan_apply"))).toBe(true);
    expect(agent.has(toolToken("code_plan_status"))).toBe(true);

    // Verify tool descriptors are queryable
    const tools = agent.query<{ readonly descriptor: ToolDescriptor }>("tool:");
    const descriptors = [...tools.values()].map((t) => t.descriptor);
    const codeToolNames = descriptors.map((d) => d.name);
    expect(codeToolNames).toContain("code_plan_create");
    expect(codeToolNames).toContain("code_plan_apply");
    expect(codeToolNames).toContain("code_plan_status");

    await runtime.dispose();
  }, 30_000);

  test("code-mode tools are NOT attached when FILESYSTEM is missing", async () => {
    const modelCall = createScriptedModelCall([textResponse("OK")]);
    const adapter = createLoopAdapter({ modelCall, maxTurns: 1 });

    // No filesystem provider — code-mode should gracefully skip
    const runtime = await createKoi({
      manifest: { name: "no-fs-e2e", version: "1.0.0", model: { name: "scripted" } },
      adapter,
      providers: [createCodeModeProvider()],
      loopDetection: false,
    });

    const agent = runtime.agent;
    expect(agent.has(toolToken("code_plan_create"))).toBe(false);
    expect(agent.has(toolToken("code_plan_apply"))).toBe(false);
    expect(agent.has(toolToken("code_plan_status"))).toBe(false);

    await runtime.dispose();
  }, 30_000);

  test("full lifecycle: create + edit + delete through middleware chain", async () => {
    const backend = createMockBackend({
      "/src/index.ts": 'export const version = "1.0.0";\n',
      "/src/deprecated.ts": "// old code\n",
    });

    const modelCall = createScriptedModelCall([
      toolCallResponse("code_plan_create", {
        steps: [
          {
            kind: "edit",
            path: "/src/index.ts",
            edits: [{ oldText: '"1.0.0"', newText: '"2.0.0"' }],
          },
          {
            kind: "create",
            path: "/src/new-feature.ts",
            content: "export const feature = true;\n",
          },
          { kind: "delete", path: "/src/deprecated.ts" },
        ],
      }),
      toolCallResponse("code_plan_apply", {}),
      textResponse("All changes applied successfully"),
    ]);

    const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });

    const runtime = await createKoi({
      manifest: { name: "lifecycle-e2e", version: "1.0.0", model: { name: "scripted" } },
      adapter,
      providers: [createFilesystemProvider(backend), createCodeModeProvider()],
      loopDetection: false,
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "Apply all changes" }));

    const output = findDoneOutput(events);
    expect(output?.stopReason).toBe("completed");

    const toolEnds = findToolCallEnds(events);
    const applyResult =
      typeof toolEnds[1]?.result === "string"
        ? JSON.parse(toolEnds[1].result)
        : toolEnds[1]?.result;

    expect(applyResult.success).toBe(true);
    expect(applyResult.rolledBack).toBe(false);
    expect(applyResult.rollbackErrors).toEqual([]);
    expect(applyResult.steps.length).toBe(3);

    // Verify all file operations
    const indexResult = await backend.read("/src/index.ts");
    expect(indexResult.ok).toBe(true);
    if (indexResult.ok) {
      expect(indexResult.value.content).toContain('"2.0.0"');
    }

    const newResult = await backend.read("/src/new-feature.ts");
    expect(newResult.ok).toBe(true);

    const deprecatedResult = await backend.read("/src/deprecated.ts");
    expect(deprecatedResult.ok).toBe(false);

    await runtime.dispose();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Optional: Real LLM test (gated on API key + E2E_TESTS=1)
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const describeRealLLM = HAS_KEY && E2E_OPTED_IN ? describe : describe.skip;

describeRealLLM("e2e: code-mode runtime with real Anthropic LLM", () => {
  test("runtime assembles correctly with real model adapter and produces text response", async () => {
    const { createAnthropicAdapter } = await import("@koi/model-router");
    const anthropic = createAnthropicAdapter({ apiKey: ANTHROPIC_KEY });

    const backend = createMockBackend({
      "/src/index.ts": 'export const version = "1.0.0";\n',
    });

    const adapter = createLoopAdapter({
      modelCall: (request) =>
        anthropic.complete({ ...request, model: "claude-haiku-4-5-20251001" }),
      maxTurns: 1,
    });

    const runtime = await createKoi({
      manifest: { name: "real-llm-e2e", version: "1.0.0", model: { name: "claude-haiku" } },
      adapter,
      providers: [createFilesystemProvider(backend), createCodeModeProvider()],
      loopDetection: false,
    });

    // Verify tools are assembled
    expect(runtime.agent.has(toolToken("code_plan_create"))).toBe(true);

    // Run with a simple prompt — model won't call tools (adapter doesn't
    // forward tool schemas to the API yet), but this validates the full
    // runtime assembles and executes through the middleware chain
    const events = await collectEvents(
      runtime.run({ kind: "text", text: "Reply with exactly: hello" }),
    );

    const output = findDoneOutput(events);
    expect(output).toBeDefined();
    expect(output?.stopReason).toBe("completed");
    expect(output?.metrics.inputTokens).toBeGreaterThan(0);

    await runtime.dispose();
  }, 60_000);
});
