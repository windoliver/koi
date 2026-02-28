/**
 * Comprehensive real-LLM E2E test for @koi/catalog.
 *
 * Proves that search_catalog and attach_capability tools work when an LLM
 * agent actually calls them mid-conversation, going through the full
 * createKoi + createLoopAdapter path with the Anthropic Messages API.
 *
 * Gated on ANTHROPIC_API_KEY + E2E_TESTS=1.
 *
 * Run: E2E_TESTS=1 bun --env-file=../../.env test src/__tests__/e2e-real-llm
 */

import { describe, expect, test } from "bun:test";
import type {
  BrickKind,
  CatalogEntry,
  ComponentProvider,
  EngineEvent,
  EngineOutput,
  JsonObject,
  KoiError,
  KoiMiddleware,
  ModelRequest,
  ModelResponse,
  Result,
  ToolDescriptor,
  ToolRequest,
  ToolResponse,
} from "@koi/core";
import { toolToken } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import { createInMemoryBrickRegistry, createTestToolArtifact } from "@koi/test-utils";

import { createBundledAdapter, createForgeAdapter } from "../adapters.js";
import { BUNDLED_ENTRIES } from "../bundled-entries.js";
import { createCatalogResolver } from "../catalog-resolver.js";
import { createCatalogComponentProvider } from "../component-provider.js";

// ---------------------------------------------------------------------------
// Gate on API key + E2E_TESTS env var
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const describeE2E = HAS_KEY && E2E_OPTED_IN ? describe : describe.skip;

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
// Type guards for untyped JSON from Koi metadata / Anthropic API
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly AnthropicToolResultBlock[] {
  return Array.isArray(value);
}

interface ToolCallMeta {
  readonly toolName: string;
  readonly callId: string;
  readonly input: JsonObject;
}

function isToolCallMetaArray(value: unknown): value is readonly ToolCallMeta[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    isRecord(value[0]) &&
    "toolName" in value[0] &&
    "callId" in value[0]
  );
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

    // @ts-expect-error — response.json() returns unknown; we validate via typed interface
    const json: AnthropicApiResponse = await response.json();
    return mapAnthropicToModelResponse(json);
  };
}

// ---------------------------------------------------------------------------
// Message conversion helpers
// ---------------------------------------------------------------------------

function mapMessagesToAnthropic(
  messages: readonly {
    readonly content: readonly { readonly kind: string; readonly text?: string }[];
    readonly senderId?: string;
    readonly metadata?: JsonObject;
  }[],
): readonly AnthropicMessage[] {
  // let justified: loop-local accumulator, push used per biome noAccumulatingSpread rule
  const result: AnthropicMessage[] = [];

  for (const msg of messages) {
    const text = msg.content
      .filter((b) => b.kind === "text" && typeof b.text === "string")
      .map((b) => b.text ?? "")
      .join("");

    if (msg.senderId === "tool") {
      const rawCallId = msg.metadata?.callId;
      const callId = typeof rawCallId === "string" ? rawCallId : "";
      const toolResult: AnthropicToolResultBlock = {
        type: "tool_result",
        tool_use_id: callId,
        content: text,
      };

      const last = result[result.length - 1];
      if (last !== undefined && last.role === "user" && isStringArray(last.content)) {
        result[result.length - 1] = {
          role: "user",
          content: [...last.content, toolResult],
        };
      } else {
        result.push({ role: "user", content: [toolResult] });
      }
    } else if (msg.senderId === "assistant") {
      const rawToolCalls = msg.metadata?.toolCalls;

      if (isToolCallMetaArray(rawToolCalls)) {
        const content: AnthropicContentBlock[] = [];
        if (text.length > 0) {
          content.push({ type: "text", text });
        }
        for (const tc of rawToolCalls) {
          content.push({ type: "tool_use", id: tc.callId, name: tc.toolName, input: tc.input });
        }
        result.push({ role: "assistant", content });
      } else {
        result.push({ role: "assistant", content: text });
      }
    } else {
      result.push({ role: "user", content: text });
    }
  }

  return result;
}

function mapAnthropicToModelResponse(response: AnthropicApiResponse): ModelResponse {
  const textParts = response.content
    .filter((b): b is AnthropicTextBlock => b.type === "text")
    .map((b) => b.text);
  const toolCalls = response.content
    .filter((b): b is AnthropicToolUseBlock => b.type === "tool_use")
    .map((b) => ({ toolName: b.name, callId: b.id, input: b.input }));

  return {
    content: textParts.join(""),
    model: response.model,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
    ...(toolCalls.length > 0 ? { metadata: { toolCalls } satisfies Record<string, unknown> } : {}),
  };
}

// ---------------------------------------------------------------------------
// Event helpers
// ---------------------------------------------------------------------------

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = []; // let justified: local accumulator for async iteration
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

function findDoneOutput(events: readonly EngineEvent[]): EngineOutput | undefined {
  const done = events.find((e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done");
  return done?.output;
}

function findToolCallStarts(
  events: readonly EngineEvent[],
): readonly (EngineEvent & { readonly kind: "tool_call_start" })[] {
  return events.filter(
    (e): e is EngineEvent & { readonly kind: "tool_call_start" } => e.kind === "tool_call_start",
  );
}

function findToolCallEnds(
  events: readonly EngineEvent[],
): readonly (EngineEvent & { readonly kind: "tool_call_end" })[] {
  return events.filter(
    (e): e is EngineEvent & { readonly kind: "tool_call_end" } => e.kind === "tool_call_end",
  );
}

// ---------------------------------------------------------------------------
// Middleware observer — records all tool calls passing through
// ---------------------------------------------------------------------------

interface ToolCallRecord {
  readonly toolName: string;
  readonly input: JsonObject;
  readonly output: unknown;
}

function createObserverMiddleware(): {
  readonly middleware: KoiMiddleware;
  readonly toolCalls: readonly ToolCallRecord[];
} {
  const toolCalls: ToolCallRecord[] = []; // let justified: test observer accumulator

  const middleware: KoiMiddleware = {
    name: "e2e-observer",
    priority: 1, // outermost — sees all calls
    describeCapabilities: () => undefined,
    wrapToolCall: async (
      _ctx,
      request: ToolRequest,
      next: (request: ToolRequest) => Promise<ToolResponse>,
    ): Promise<ToolResponse> => {
      const response = await next(request);
      toolCalls.push({
        toolName: request.toolId,
        input: request.input,
        output: response.output,
      });
      return response;
    },
  };

  return {
    middleware,
    get toolCalls() {
      return toolCalls;
    },
  };
}

// ---------------------------------------------------------------------------
// Two-phase runtime factory
// ---------------------------------------------------------------------------

const DEFAULT_ALLOWED_KINDS = ["tool", "skill"] as const satisfies readonly BrickKind[];

interface CatalogProviderOptions {
  readonly includeForge?: boolean;
  readonly forgeRegistry?: ReturnType<typeof createInMemoryBrickRegistry>;
  readonly allowedKinds?: readonly BrickKind[];
  readonly onAttach?: (entry: CatalogEntry) => Promise<Result<void, KoiError>>;
}

function createCatalogProvider(options: CatalogProviderOptions = {}): ComponentProvider {
  const baseAdapters = [createBundledAdapter(BUNDLED_ENTRIES)];
  const adapters =
    options.includeForge === true && options.forgeRegistry !== undefined
      ? [...baseAdapters, createForgeAdapter(options.forgeRegistry)]
      : baseAdapters;

  const reader = createCatalogResolver({ adapters });

  const providerConfig = {
    reader,
    allowedKinds: options.allowedKinds ?? DEFAULT_ALLOWED_KINDS,
    ...(options.onAttach !== undefined ? { onAttach: options.onAttach } : {}),
  };

  return createCatalogComponentProvider(providerConfig);
}

function extractToolDescriptors(agent: {
  readonly components: () => ReadonlyMap<string, unknown>;
}): readonly ToolDescriptor[] {
  return [...agent.components()]
    .filter(([key]) => key.startsWith("tool:"))
    .map(([, value]) => {
      // Component value is untyped (Map<string, unknown>) — cast matches code-mode pattern
      const tool = value as { readonly descriptor: ToolDescriptor };
      return tool.descriptor;
    });
}

async function createRealLLMRuntime(
  catalogProvider: ComponentProvider,
  maxTurns: number,
  middleware?: readonly KoiMiddleware[],
): Promise<Awaited<ReturnType<typeof createKoi>>> {
  // Phase 1: Assemble to discover tool descriptors
  const discoveryAdapter = createLoopAdapter({
    modelCall: async () => ({ content: "noop", model: "discovery" }),
    maxTurns: 1,
  });

  const discoveryRuntime = await createKoi({
    manifest: { name: "catalog-discovery", version: "0.0.0", model: { name: "discovery" } },
    adapter: discoveryAdapter,
    providers: [catalogProvider],
    ...(middleware !== undefined ? { middleware } : {}),
    loopDetection: false,
  });

  const toolDescriptors = extractToolDescriptors(discoveryRuntime.agent);
  await discoveryRuntime.dispose();

  // Phase 2: Create real runtime with tool-aware model call
  const modelCall = createAnthropicModelCall(ANTHROPIC_KEY, toolDescriptors);
  const adapter = createLoopAdapter({ modelCall, maxTurns });

  return createKoi({
    manifest: { name: "catalog-e2e", version: "1.0.0", model: { name: "claude-haiku" } },
    adapter,
    providers: [catalogProvider],
    ...(middleware !== undefined ? { middleware } : {}),
    loopDetection: false,
  });
}

// ---------------------------------------------------------------------------
// Result parsing helpers
// ---------------------------------------------------------------------------

function parseToolResult(result: unknown): Record<string, unknown> | undefined {
  if (result === undefined || result === null) return undefined;
  if (typeof result === "string") {
    try {
      const parsed: unknown = JSON.parse(result);
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return isRecord(result) ? result : undefined;
}

function hasItemNamed(result: Record<string, unknown>, name: string): boolean {
  const items = result.items;
  if (!Array.isArray(items)) return false;
  return items.some((item: unknown) => isRecord(item) && item.name === name);
}

interface CatalogItem {
  readonly name: string;
  readonly kind: string;
  readonly description: string;
}

function extractItems(result: Record<string, unknown>): readonly CatalogItem[] {
  const items = result.items;
  if (!Array.isArray(items)) return [];
  return items.filter(
    (item: unknown): item is CatalogItem =>
      isRecord(item) &&
      typeof item.name === "string" &&
      typeof item.kind === "string" &&
      typeof item.description === "string",
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: real Anthropic LLM catalog tests", () => {
  // -----------------------------------------------------------------------
  // 1. Tool discovery (no LLM call needed)
  // -----------------------------------------------------------------------

  test("search_catalog and attach_capability are registered on the agent", async () => {
    const provider = createCatalogProvider();
    const runtime = await createRealLLMRuntime(provider, 1);

    try {
      expect(runtime.agent.has(toolToken("search_catalog"))).toBe(true);
      expect(runtime.agent.has(toolToken("attach_capability"))).toBe(true);
    } finally {
      await runtime.dispose();
    }
  }, 30_000);

  // -----------------------------------------------------------------------
  // 2. LLM calls search_catalog to find middleware
  // -----------------------------------------------------------------------

  test("LLM calls search_catalog to find PII middleware", async () => {
    const provider = createCatalogProvider();
    const runtime = await createRealLLMRuntime(provider, 3);

    try {
      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: [
            "You have two tools: search_catalog and attach_capability.",
            "Use search_catalog to find middleware for PII redaction.",
            "Pass text='pii' to search_catalog. Do NOT explain, just call the tool.",
          ].join("\n"),
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();

      // Verify search_catalog was called
      const toolStarts = findToolCallStarts(events);
      const searchStart = toolStarts.find((e) => e.toolName === "search_catalog");
      expect(searchStart).toBeDefined();

      // Verify result contains middleware-pii
      const toolEnds = findToolCallEnds(events);
      const searchEnd = toolEnds.find((e) => {
        const result = parseToolResult(e.result);
        return result !== undefined && hasItemNamed(result, "bundled:@koi/middleware-pii");
      });
      expect(searchEnd).toBeDefined();
    } finally {
      await runtime.dispose();
    }
  }, 120_000);

  // -----------------------------------------------------------------------
  // 3. LLM calls search_catalog with kind filter
  // -----------------------------------------------------------------------

  test("LLM calls search_catalog with kind=channel", async () => {
    const provider = createCatalogProvider();
    const runtime = await createRealLLMRuntime(provider, 3);

    try {
      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: [
            "You have two tools: search_catalog and attach_capability.",
            "Use search_catalog to list all channels. Pass kind='channel'.",
            "Do NOT explain, just call the tool.",
          ].join("\n"),
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();

      // Find the search_catalog result
      const toolEnds = findToolCallEnds(events);
      const searchEnd = toolEnds.find((e) => {
        const result = parseToolResult(e.result);
        return result !== undefined && Array.isArray(result.items);
      });
      expect(searchEnd).toBeDefined();

      if (searchEnd !== undefined) {
        const result = parseToolResult(searchEnd.result);
        if (result === undefined) {
          throw new Error("Expected parsed tool result");
        }

        const items = extractItems(result);
        expect(items.length).toBeGreaterThanOrEqual(1);

        // All results should be channels
        for (const item of items) {
          expect(item.kind).toBe("channel");
        }

        // Should contain known channels
        const names = items.map((i) => i.name);
        expect(names).toContain("bundled:@koi/channel-cli");

        // Should NOT contain middleware
        const hasMiddleware = items.some((i) => i.kind === "middleware");
        expect(hasMiddleware).toBe(false);
      }
    } finally {
      await runtime.dispose();
    }
  }, 120_000);

  // -----------------------------------------------------------------------
  // 4. LLM calls search_catalog with text search
  // -----------------------------------------------------------------------

  test("LLM calls search_catalog with text=docker", async () => {
    const provider = createCatalogProvider();
    const runtime = await createRealLLMRuntime(provider, 3);

    try {
      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: [
            "You have two tools: search_catalog and attach_capability.",
            "Use search_catalog with text='docker' to find sandbox capabilities.",
            "Do NOT explain, just call the tool.",
          ].join("\n"),
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();

      // Verify result contains sandbox-docker
      const toolEnds = findToolCallEnds(events);
      const searchEnd = toolEnds.find((e) => {
        const result = parseToolResult(e.result);
        return result !== undefined && hasItemNamed(result, "bundled:@koi/sandbox-docker");
      });
      expect(searchEnd).toBeDefined();

      if (searchEnd !== undefined) {
        const result = parseToolResult(searchEnd.result);
        if (result !== undefined) {
          const items = extractItems(result);
          const dockerEntry = items.find((i) => i.name === "bundled:@koi/sandbox-docker");
          expect(dockerEntry).toBeDefined();
          if (dockerEntry !== undefined) {
            expect(dockerEntry.description.toLowerCase()).toContain("docker");
          }
        }
      }
    } finally {
      await runtime.dispose();
    }
  }, 120_000);

  // -----------------------------------------------------------------------
  // 5. LLM calls attach_capability (permission denied for middleware)
  // -----------------------------------------------------------------------

  test("LLM gets PERMISSION_DENIED when attaching middleware", async () => {
    const provider = createCatalogProvider({
      allowedKinds: ["tool", "skill"], // middleware not allowed
    });
    const runtime = await createRealLLMRuntime(provider, 3);

    try {
      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: [
            "You have two tools: search_catalog and attach_capability.",
            "Use attach_capability to attach 'bundled:@koi/middleware-pii'.",
            "Do NOT explain, just call the tool with name='bundled:@koi/middleware-pii'.",
          ].join("\n"),
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();

      // Verify attach_capability was called
      const toolStarts = findToolCallStarts(events);
      const attachStart = toolStarts.find((e) => e.toolName === "attach_capability");
      expect(attachStart).toBeDefined();

      // Verify PERMISSION_DENIED in the result
      const toolEnds = findToolCallEnds(events);
      const attachEnd = toolEnds.find((e) => {
        const result = parseToolResult(e.result);
        return result !== undefined && result.code === "PERMISSION_DENIED";
      });
      expect(attachEnd).toBeDefined();
    } finally {
      await runtime.dispose();
    }
  }, 120_000);

  // -----------------------------------------------------------------------
  // 6. Full search -> attach flow with middleware observer
  // -----------------------------------------------------------------------

  test("full search then attach flow with forged tool and middleware observer", async () => {
    // Set up a forge registry with a calculator tool
    const forgeRegistry = createInMemoryBrickRegistry();
    forgeRegistry.register(
      createTestToolArtifact({
        name: "calculator",
        description: "A simple calculator tool for arithmetic",
        tags: ["tool", "calculator", "math"],
      }),
    );

    // Track what was attached
    const attachedEntries: CatalogEntry[] = []; // let justified: test assertion accumulator

    const provider = createCatalogProvider({
      includeForge: true,
      forgeRegistry,
      allowedKinds: ["tool", "skill"],
      onAttach: async (entry) => {
        attachedEntries.push(entry);
        return { ok: true, value: undefined };
      },
    });

    // Wire middleware observer
    const observer = createObserverMiddleware();
    const runtime = await createRealLLMRuntime(provider, 5, [observer.middleware]);

    try {
      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: [
            "You have two tools: search_catalog and attach_capability.",
            "Step 1: Use search_catalog with text='calculator' to find calculator tools.",
            "Step 2: After seeing results, use attach_capability with name='forged:calculator' to attach it.",
            "Do these steps IN ORDER. Do NOT explain, just call the tools.",
          ].join("\n"),
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();

      // Verify both tools were called
      const toolStarts = findToolCallStarts(events);
      const searchStarts = toolStarts.filter((e) => e.toolName === "search_catalog");
      const attachStarts = toolStarts.filter((e) => e.toolName === "attach_capability");
      expect(searchStarts.length).toBeGreaterThanOrEqual(1);
      expect(attachStarts.length).toBeGreaterThanOrEqual(1);

      // Verify search_catalog was called before attach_capability (by event order)
      const firstSearchIndex = events.findIndex(
        (e) => e.kind === "tool_call_start" && e.toolName === "search_catalog",
      );
      const firstAttachIndex = events.findIndex(
        (e) => e.kind === "tool_call_start" && e.toolName === "attach_capability",
      );
      expect(firstSearchIndex).toBeLessThan(firstAttachIndex);

      // Verify onAttach callback fired with the calculator entry
      expect(attachedEntries.length).toBe(1);
      const attached = attachedEntries[0];
      if (attached === undefined) {
        throw new Error("Expected onAttach to have been called");
      }
      expect(attached.name).toBe("forged:calculator");
      expect(attached.kind).toBe("tool");
      expect(attached.source).toBe("forged");

      // Verify middleware observer saw both catalog tool calls
      const observedToolNames = observer.toolCalls.map((tc) => tc.toolName);
      expect(observedToolNames).toContain("search_catalog");
      expect(observedToolNames).toContain("attach_capability");
    } finally {
      await runtime.dispose();
    }
  }, 120_000);
});
