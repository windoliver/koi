/**
 * Comprehensive real-LLM E2E test for @koi/code-mode.
 *
 * Goes through the full createKoi + createLoopAdapter path with a custom
 * modelCall that passes tool schemas to the Anthropic API and parses
 * tool_use responses — proving all 4 step kinds work with a real LLM.
 *
 * Gated on ANTHROPIC_API_KEY + E2E_TESTS=1.
 *
 * Run: E2E_TESTS=1 bun --env-file=/Users/taofeng/koi/.env test e2e-real-llm
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
// Gate on API key + E2E_TESTS env var
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const describeReal = HAS_KEY && E2E_OPTED_IN ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Anthropic API types (tool calling)
// ---------------------------------------------------------------------------

interface AnthropicToolParam {
  readonly name: string;
  readonly description: string;
  readonly input_schema: JsonObject;
}

interface AnthropicTextBlock {
  readonly type: "text";
  readonly text: string;
}

interface AnthropicToolUseBlock {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: JsonObject;
}

type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock;

interface AnthropicToolResultBlock {
  readonly type: "tool_result";
  readonly tool_use_id: string;
  readonly content: string;
}

type AnthropicMessageContent =
  | string
  | readonly (AnthropicContentBlock | AnthropicToolResultBlock)[];

interface AnthropicMessage {
  readonly role: "user" | "assistant";
  readonly content: AnthropicMessageContent;
}

interface AnthropicApiResponse {
  readonly id: string;
  readonly model: string;
  readonly content: readonly AnthropicContentBlock[];
  readonly stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
}

// ---------------------------------------------------------------------------
// Custom modelCall that bridges to Anthropic API WITH tool schemas
// ---------------------------------------------------------------------------

function createAnthropicModelCall(
  apiKey: string,
  toolDescriptors: readonly ToolDescriptor[],
): (request: ModelRequest) => Promise<ModelResponse> {
  const tools: readonly AnthropicToolParam[] = toolDescriptors.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: t.inputSchema ?? { type: "object", properties: {} },
  }));

  return async (request: ModelRequest): Promise<ModelResponse> => {
    // Convert Koi messages to Anthropic format, handling tool results
    const messages = mapMessagesToAnthropic(request.messages);

    const body = {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4096,
      messages,
      tools,
    };

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`Anthropic API ${response.status}: ${errorText}`);
    }

    const json = (await response.json()) as AnthropicApiResponse;
    return mapAnthropicToModelResponse(json);
  };
}

/**
 * Convert Koi InboundMessage[] to Anthropic message format.
 *
 * Handles three cases:
 * - User messages (senderId !== "assistant" and !== "tool")
 * - Assistant messages (may contain tool_use metadata)
 * - Tool result messages (senderId === "tool", has toolName/callId in metadata)
 */
function mapMessagesToAnthropic(
  messages: readonly {
    readonly content: readonly { readonly kind: string; readonly text?: string }[];
    readonly senderId?: string;
    readonly metadata?: JsonObject;
  }[],
): readonly AnthropicMessage[] {
  const result: AnthropicMessage[] = [];

  for (const msg of messages) {
    const text = msg.content
      .filter((b) => b.kind === "text" && typeof b.text === "string")
      .map((b) => b.text ?? "")
      .join("");

    if (msg.senderId === "tool") {
      // Tool result — must be paired with the preceding assistant message
      const callId = (msg.metadata?.callId as string) ?? "";
      const toolResult: AnthropicToolResultBlock = {
        type: "tool_result",
        tool_use_id: callId,
        content: text,
      };

      // Check if last message in result is already a "user" with tool_result content
      const last = result[result.length - 1];
      if (last !== undefined && last.role === "user" && Array.isArray(last.content)) {
        // Append to existing tool result group
        result[result.length - 1] = {
          role: "user",
          content: [...(last.content as readonly AnthropicToolResultBlock[]), toolResult],
        };
      } else {
        result.push({ role: "user", content: [toolResult] });
      }
    } else if (msg.senderId === "assistant") {
      // Assistant — check for tool calls in metadata
      const toolCalls = msg.metadata?.toolCalls as
        | readonly {
            readonly toolName: string;
            readonly callId: string;
            readonly input: JsonObject;
          }[]
        | undefined;

      if (toolCalls !== undefined && toolCalls.length > 0) {
        const content: AnthropicContentBlock[] = [];
        if (text.length > 0) {
          content.push({ type: "text", text });
        }
        for (const tc of toolCalls) {
          content.push({
            type: "tool_use",
            id: tc.callId,
            name: tc.toolName,
            input: tc.input,
          });
        }
        result.push({ role: "assistant", content });
      } else {
        result.push({ role: "assistant", content: text });
      }
    } else {
      // User message
      result.push({ role: "user", content: text });
    }
  }

  return result;
}

/**
 * Convert Anthropic API response to Koi ModelResponse.
 * Extracts tool_use blocks into metadata.toolCalls.
 */
function mapAnthropicToModelResponse(response: AnthropicApiResponse): ModelResponse {
  const textParts: string[] = [];
  const toolCalls: {
    readonly toolName: string;
    readonly callId: string;
    readonly input: JsonObject;
  }[] = [];

  for (const block of response.content) {
    if (block.type === "text") {
      textParts.push(block.text);
    } else if (block.type === "tool_use") {
      toolCalls.push({
        toolName: block.name,
        callId: block.id,
        input: block.input,
      });
    }
  }

  return {
    content: textParts.join(""),
    model: response.model,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
    ...(toolCalls.length > 0
      ? { metadata: { toolCalls: toolCalls as unknown as JsonObject[] } as JsonObject }
      : {}),
  };
}

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

function createFilesystemProvider(backend: FileSystemBackend): ComponentProvider {
  return {
    name: "filesystem",
    attach: async (): Promise<ReadonlyMap<string, unknown>> => {
      return new Map<string, unknown>([[FILESYSTEM as string, backend]]);
    },
  };
}

/**
 * Build a runtime with a real Anthropic model call that includes tool schemas.
 *
 * Two-phase: first assemble to discover tools, then create the real modelCall.
 */
async function createRealLLMRuntime(
  backend: FileSystemBackend,
  maxTurns: number,
): Promise<{
  readonly runtime: Awaited<ReturnType<typeof createKoi>>;
  readonly backend: FileSystemBackend;
}> {
  // Phase 1: Assemble to discover tool descriptors
  const discoveryAdapter = createLoopAdapter({
    modelCall: async () => ({ content: "noop", model: "discovery" }),
    maxTurns: 1,
  });

  const discoveryRuntime = await createKoi({
    manifest: { name: "discovery", version: "0.0.0", model: { name: "discovery" } },
    adapter: discoveryAdapter,
    providers: [createFilesystemProvider(backend), createCodeModeProvider()],
    loopDetection: false,
  });

  // Extract tool descriptors from the assembled agent
  const toolDescriptors: ToolDescriptor[] = [];
  for (const [key, value] of discoveryRuntime.agent.components()) {
    if (key.startsWith("tool:")) {
      const tool = value as { readonly descriptor: ToolDescriptor };
      toolDescriptors.push(tool.descriptor);
    }
  }

  await discoveryRuntime.dispose();

  // Phase 2: Create real runtime with tool-aware model call
  const modelCall = createAnthropicModelCall(ANTHROPIC_KEY, toolDescriptors);

  const adapter = createLoopAdapter({ modelCall, maxTurns });

  const runtime = await createKoi({
    manifest: { name: "real-llm-e2e", version: "1.0.0", model: { name: "claude-haiku" } },
    adapter,
    providers: [createFilesystemProvider(backend), createCodeModeProvider()],
    loopDetection: false,
  });

  return { runtime, backend };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeReal("e2e: real Anthropic LLM comprehensive code-mode tests", () => {
  test("LLM creates a file via code_plan_create + code_plan_apply", async () => {
    const backend = createMockBackend();
    const { runtime } = await createRealLLMRuntime(backend, 5);

    const events = await collectEvents(
      runtime.run({
        kind: "text",
        text: [
          "You have these tools: code_plan_create, code_plan_apply, code_plan_status.",
          'Create a file at /src/hello.ts with content: export const greeting = "hello world";',
          "First call code_plan_create with a create step, then call code_plan_apply.",
          "Do NOT explain, just call the tools.",
        ].join("\n"),
      }),
    );

    const output = findDoneOutput(events);
    expect(output).toBeDefined();

    const toolEnds = findToolCallEnds(events);
    expect(toolEnds.length).toBeGreaterThanOrEqual(2);

    // Verify file was created
    const readResult = await backend.read("/src/hello.ts");
    expect(readResult.ok).toBe(true);
    if (readResult.ok) {
      expect(readResult.value.content).toContain("hello world");
    }

    await runtime.dispose();
  }, 120_000);

  test("LLM edits an existing file via code_plan_create + code_plan_apply", async () => {
    const backend = createMockBackend({
      "/src/config.ts": 'export const version = "1.0.0";\nexport const name = "my-app";\n',
    });
    const { runtime } = await createRealLLMRuntime(backend, 5);

    const events = await collectEvents(
      runtime.run({
        kind: "text",
        text: [
          "You have these tools: code_plan_create, code_plan_apply.",
          'Edit the file /src/config.ts to change the version from "1.0.0" to "2.0.0".',
          "Use kind='edit' with oldText and newText.",
          "First call code_plan_create, then code_plan_apply. Do NOT explain.",
        ].join("\n"),
      }),
    );

    const output = findDoneOutput(events);
    expect(output).toBeDefined();

    const toolEnds = findToolCallEnds(events);
    expect(toolEnds.length).toBeGreaterThanOrEqual(2);

    // Verify edit was applied
    const readResult = await backend.read("/src/config.ts");
    expect(readResult.ok).toBe(true);
    if (readResult.ok) {
      expect(readResult.value.content).toContain('"2.0.0"');
      expect(readResult.value.content).not.toContain('"1.0.0"');
    }

    await runtime.dispose();
  }, 120_000);

  test("LLM deletes a file via code_plan_create + code_plan_apply", async () => {
    const backend = createMockBackend({
      "/src/legacy.ts": "// deprecated module\nexport const old = true;\n",
      "/src/main.ts": "export const main = true;\n",
    });
    const { runtime } = await createRealLLMRuntime(backend, 5);

    const events = await collectEvents(
      runtime.run({
        kind: "text",
        text: [
          "You have these tools: code_plan_create, code_plan_apply.",
          "Delete the file /src/legacy.ts (it is deprecated).",
          "Use kind='delete'. First code_plan_create, then code_plan_apply. Do NOT explain.",
        ].join("\n"),
      }),
    );

    const output = findDoneOutput(events);
    expect(output).toBeDefined();

    // Verify file was deleted
    const readResult = await backend.read("/src/legacy.ts");
    expect(readResult.ok).toBe(false);

    // main.ts should still exist
    const mainResult = await backend.read("/src/main.ts");
    expect(mainResult.ok).toBe(true);

    await runtime.dispose();
  }, 120_000);

  test("LLM renames a file via code_plan_create + code_plan_apply", async () => {
    const backend = createMockBackend({
      "/src/old-utils.ts": "export function add(a: number, b: number): number { return a + b; }\n",
    });
    const { runtime } = await createRealLLMRuntime(backend, 5);

    const events = await collectEvents(
      runtime.run({
        kind: "text",
        text: [
          "You have these tools: code_plan_create, code_plan_apply.",
          "Rename the file /src/old-utils.ts to /src/utils.ts.",
          "Use kind='rename' with path='/src/old-utils.ts' and to='/src/utils.ts'.",
          "First code_plan_create, then code_plan_apply. Do NOT explain.",
        ].join("\n"),
      }),
    );

    const output = findDoneOutput(events);
    expect(output).toBeDefined();

    // Verify rename: old path gone, new path exists with same content
    const oldResult = await backend.read("/src/old-utils.ts");
    expect(oldResult.ok).toBe(false);

    const newResult = await backend.read("/src/utils.ts");
    expect(newResult.ok).toBe(true);
    if (newResult.ok) {
      expect(newResult.value.content).toContain("function add");
    }

    await runtime.dispose();
  }, 120_000);

  test("LLM performs multi-step plan with all 4 step kinds", async () => {
    const backend = createMockBackend({
      "/src/index.ts": 'export const version = "1.0.0";\n',
      "/src/deprecated.ts": "// remove this\n",
      "/src/old-helper.ts": "export const helper = true;\n",
    });
    const { runtime } = await createRealLLMRuntime(backend, 5);

    const events = await collectEvents(
      runtime.run({
        kind: "text",
        text: [
          "You have these tools: code_plan_create, code_plan_apply.",
          "Perform ALL of these operations in a SINGLE code_plan_create call with 4 steps:",
          '1. Edit /src/index.ts: change "1.0.0" to "2.0.0"',
          "2. Create /src/new-feature.ts with content: export const feature = true;",
          "3. Delete /src/deprecated.ts",
          "4. Rename /src/old-helper.ts to /src/helper.ts",
          "Then call code_plan_apply. Do NOT explain, just call the tools.",
        ].join("\n"),
      }),
    );

    const output = findDoneOutput(events);
    expect(output).toBeDefined();

    const toolEnds = findToolCallEnds(events);
    expect(toolEnds.length).toBeGreaterThanOrEqual(2);

    // Check the apply result
    const applyEnd = toolEnds.find((e) => {
      const result = typeof e.result === "string" ? JSON.parse(e.result) : e.result;
      return (
        result !== null &&
        typeof result === "object" &&
        "success" in (result as Record<string, unknown>)
      );
    });

    if (applyEnd !== undefined) {
      const applyResult =
        typeof applyEnd.result === "string" ? JSON.parse(applyEnd.result) : applyEnd.result;
      expect((applyResult as { success: boolean }).success).toBe(true);
    }

    // Verify all 4 operations
    const indexResult = await backend.read("/src/index.ts");
    expect(indexResult.ok).toBe(true);
    if (indexResult.ok) {
      expect(indexResult.value.content).toContain('"2.0.0"');
    }

    const newFeatureResult = await backend.read("/src/new-feature.ts");
    expect(newFeatureResult.ok).toBe(true);

    const deprecatedResult = await backend.read("/src/deprecated.ts");
    expect(deprecatedResult.ok).toBe(false);

    const oldHelperResult = await backend.read("/src/old-helper.ts");
    expect(oldHelperResult.ok).toBe(false);

    const helperResult = await backend.read("/src/helper.ts");
    expect(helperResult.ok).toBe(true);
    if (helperResult.ok) {
      expect(helperResult.value.content).toContain("helper");
    }

    await runtime.dispose();
  }, 120_000);

  test("LLM receives preview with context lines from code_plan_create", async () => {
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
    const { runtime } = await createRealLLMRuntime(backend, 5);

    const events = await collectEvents(
      runtime.run({
        kind: "text",
        text: [
          "You have these tools: code_plan_create, code_plan_apply.",
          'Edit /src/index.ts to change "1.0.0" to "2.0.0".',
          "First call code_plan_create, then code_plan_apply. Do NOT explain.",
        ].join("\n"),
      }),
    );

    const output = findDoneOutput(events);
    expect(output).toBeDefined();

    // Find the code_plan_create result which should have a preview
    const toolEnds = findToolCallEnds(events);
    const createEnd = toolEnds[0];
    expect(createEnd).toBeDefined();

    if (createEnd !== undefined) {
      const preview =
        typeof createEnd.result === "string" ? JSON.parse(createEnd.result) : createEnd.result;

      // Verify it's a PlanPreview with context lines
      expect((preview as { planId: string }).planId).toBeDefined();
      expect((preview as { summary: string }).summary).toContain("edit");

      const files = (preview as { files: readonly { lines: readonly string[] }[] }).files;
      expect(files.length).toBeGreaterThanOrEqual(1);

      const editFile = files[0];
      if (editFile !== undefined) {
        // Should have context lines (lines starting with "  ")
        const contextLines = editFile.lines.filter((l: string) => l.startsWith("  "));
        expect(contextLines.length).toBeGreaterThan(0);
      }
    }

    await runtime.dispose();
  }, 120_000);

  test("tool discovery: all 4 tool names are registered on the agent", async () => {
    const backend = createMockBackend();
    const { runtime } = await createRealLLMRuntime(backend, 1);

    expect(runtime.agent.has(toolToken("code_plan_create"))).toBe(true);
    expect(runtime.agent.has(toolToken("code_plan_apply"))).toBe(true);
    expect(runtime.agent.has(toolToken("code_plan_status"))).toBe(true);

    await runtime.dispose();
  }, 30_000);
});
