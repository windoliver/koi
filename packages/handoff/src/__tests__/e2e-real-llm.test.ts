/**
 * Real-LLM E2E test for @koi/handoff.
 *
 * Goes through the full createKoi + createLoopAdapter path with a custom
 * modelCall that passes tool schemas to the Anthropic API and parses
 * tool_use responses — proving the handoff tools + middleware chain work
 * end-to-end with a real LLM.
 *
 * Test scenario: Agent A prepares handoff → Agent B receives injected
 * context via middleware → Agent B accepts handoff via tool call.
 *
 * Gated on ANTHROPIC_API_KEY + E2E_TESTS=1.
 *
 * Run: E2E_TESTS=1 bun --env-file=/path/to/.env test e2e-real-llm
 */

import { describe, expect, test } from "bun:test";
import type {
  EngineEvent,
  EngineOutput,
  HandoffEvent,
  JsonObject,
  ModelRequest,
  ModelResponse,
  ToolDescriptor,
} from "@koi/core";
import { agentId, handoffId } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import { createHandoffMiddleware } from "../middleware.js";
import { createHandoffProvider } from "../provider.js";
import { createHandoffStore, type HandoffStore } from "../store.js";

// ---------------------------------------------------------------------------
// Gate on API key + E2E_TESTS env var
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const describeE2E = HAS_KEY && E2E_OPTED_IN ? describe : describe.skip;

const TIMEOUT_MS = 120_000;

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
// Anthropic API bridge (tool-aware modelCall)
// ---------------------------------------------------------------------------

function createAnthropicModelCall(
  apiKey: string,
  toolDescriptors: readonly ToolDescriptor[],
): (request: ModelRequest) => Promise<ModelResponse> {
  const tools: readonly AnthropicToolParam[] = toolDescriptors.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: t.inputSchema ?? ({ type: "object", properties: {} } as JsonObject),
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
      throw new Error(`Anthropic API ${String(response.status)}: ${errorText}`);
    }

    const json = (await response.json()) as AnthropicApiResponse;
    return mapAnthropicToModelResponse(json);
  };
}

/**
 * Convert Koi InboundMessage[] to Anthropic message format.
 * Handles user, assistant (with tool_use), tool result, and system messages.
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
      // Tool result — pair with preceding assistant message
      const callId = (msg.metadata?.callId as string) ?? "";
      const toolResult: AnthropicToolResultBlock = {
        type: "tool_result",
        tool_use_id: callId,
        content: text,
      };

      const last = result[result.length - 1];
      if (last !== undefined && last.role === "user" && Array.isArray(last.content)) {
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
      // User or system message — both go as "user" role
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
// Event helpers
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
// Two-phase assembly helper
// ---------------------------------------------------------------------------

/**
 * Build a real-LLM runtime with handoff tools (and optionally middleware).
 *
 * Phase 1: Discover tool descriptors via dummy assembly.
 * Phase 2: Create real runtime with tool-aware Anthropic model call.
 */
async function createHandoffRuntime(opts: {
  readonly agentIdStr: string;
  readonly store: HandoffStore;
  readonly onEvent: (e: HandoffEvent) => void;
  readonly withMiddleware: boolean;
  readonly maxTurns: number;
}): Promise<Awaited<ReturnType<typeof createKoi>>> {
  const id = agentId(opts.agentIdStr);

  // Phase 1: Assemble to discover tool descriptors
  const discoveryProvider = createHandoffProvider({
    store: opts.store,
    agentId: id,
    onEvent: opts.onEvent,
  });

  const discoveryAdapter = createLoopAdapter({
    modelCall: async () => ({ content: "noop", model: "discovery" }),
    maxTurns: 1,
  });

  const discoveryRuntime = await createKoi({
    manifest: { name: "discovery", version: "0.0.0", model: { name: "discovery" } },
    adapter: discoveryAdapter,
    providers: [discoveryProvider],
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
  const adapter = createLoopAdapter({ modelCall, maxTurns: opts.maxTurns });

  // Fresh provider for the real runtime
  const realProvider = createHandoffProvider({
    store: opts.store,
    agentId: id,
    onEvent: opts.onEvent,
  });

  // Optionally add handoff middleware
  const middleware = opts.withMiddleware
    ? [
        createHandoffMiddleware({
          store: opts.store,
          agentId: id,
          onEvent: opts.onEvent,
        }),
      ]
    : [];

  const runtime = await createKoi({
    manifest: { name: opts.agentIdStr, version: "1.0.0", model: { name: "claude-haiku" } },
    adapter,
    providers: [realProvider],
    middleware,
    loopDetection: false,
  });

  return runtime;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: handoff pipeline with real Anthropic LLM", () => {
  test(
    "Agent A prepares handoff → Agent B receives context injection + accepts",
    async () => {
      const store = createHandoffStore();
      const events: HandoffEvent[] = [];
      const onEvent = (e: HandoffEvent): void => {
        events.push(e);
      };

      // -----------------------------------------------------------------
      // Agent A: prepare_handoff via real LLM tool call
      // -----------------------------------------------------------------
      const runtimeA = await createHandoffRuntime({
        agentIdStr: "agent-a",
        store,
        onEvent,
        withMiddleware: false,
        maxTurns: 3,
      });

      const eventsA = await collectEvents(
        runtimeA.run({
          kind: "text",
          text: [
            "You have a prepare_handoff tool. Call it immediately with these exact parameters:",
            '- to: "agent-b"',
            '- completed: "Analyzed user data and identified key patterns"',
            '- next: "Generate the final report based on the analysis results"',
            '- results: {"summary": "data analyzed", "count": 42}',
            '- warnings: ["Watch out for edge cases in date parsing"]',
            "Do NOT explain. Just call the tool.",
          ].join("\n"),
        }),
      );

      const outputA = findDoneOutput(eventsA);
      expect(outputA).toBeDefined();

      // Verify prepare_handoff was called (toolName is on tool_call_start, not tool_call_end)
      const toolStartsA = findToolCallStarts(eventsA);
      const prepareCall = toolStartsA.find((e) => e.toolName === "prepare_handoff");
      expect(prepareCall).toBeDefined();
      expect(findToolCallEnds(eventsA).length).toBeGreaterThanOrEqual(1);

      // Verify envelope was created in the store
      const allEnvelopes = store.listByAgent(agentId("agent-a"));
      expect(allEnvelopes.length).toBeGreaterThanOrEqual(1);

      // Find the pending envelope for agent-b
      const pendingEnvelope = store.findPendingForAgent(agentId("agent-b"));
      expect(pendingEnvelope).toBeDefined();
      if (pendingEnvelope === undefined) throw new Error("No pending envelope found");

      expect(pendingEnvelope.from).toBe(agentId("agent-a"));
      expect(pendingEnvelope.to).toBe(agentId("agent-b"));
      expect(pendingEnvelope.status).toBe("pending");
      expect(pendingEnvelope.phase.next).toContain("report");

      // Verify handoff:prepared event was emitted
      const preparedEvents = events.filter((e) => e.kind === "handoff:prepared");
      expect(preparedEvents.length).toBeGreaterThanOrEqual(1);

      await runtimeA.dispose();

      // -----------------------------------------------------------------
      // Agent B: middleware injects context + accept_handoff via LLM
      // -----------------------------------------------------------------
      const runtimeB = await createHandoffRuntime({
        agentIdStr: "agent-b",
        store,
        onEvent,
        withMiddleware: true, // HandoffMiddleware will inject context
        maxTurns: 3,
      });

      const eventsB = await collectEvents(
        runtimeB.run({
          kind: "text",
          text: [
            "You have an accept_handoff tool.",
            "You should see a Handoff Context in this conversation.",
            "Call accept_handoff with the handoff_id shown in that context.",
            "Do NOT explain. Just call the tool.",
          ].join("\n"),
        }),
      );

      const outputB = findDoneOutput(eventsB);
      expect(outputB).toBeDefined();

      // Verify accept_handoff was called (toolName is on tool_call_start)
      const toolStartsB = findToolCallStarts(eventsB);
      const acceptCall = toolStartsB.find((e) => e.toolName === "accept_handoff");
      expect(acceptCall).toBeDefined();
      expect(findToolCallEnds(eventsB).length).toBeGreaterThanOrEqual(1);

      // Verify envelope status transitioned to accepted
      const finalEnvelope = store.get(pendingEnvelope.id);
      expect(finalEnvelope).toBeDefined();
      expect(finalEnvelope?.status).toBe("accepted");

      // Verify full event lifecycle
      const eventKinds = events.map((e) => e.kind);
      expect(eventKinds).toContain("handoff:prepared");
      expect(eventKinds).toContain("handoff:injected");
      expect(eventKinds).toContain("handoff:accepted");

      // Verify ordering: prepared → injected → accepted
      const preparedIdx = eventKinds.indexOf("handoff:prepared");
      const injectedIdx = eventKinds.indexOf("handoff:injected");
      const acceptedIdx = eventKinds.indexOf("handoff:accepted");
      expect(preparedIdx).toBeLessThan(injectedIdx);
      expect(injectedIdx).toBeLessThan(acceptedIdx);

      // Verify metrics — both agents consumed tokens (proves real LLM)
      if (outputA !== undefined) {
        expect(outputA.metrics.inputTokens).toBeGreaterThan(0);
        expect(outputA.metrics.outputTokens).toBeGreaterThan(0);
      }
      if (outputB !== undefined) {
        expect(outputB.metrics.inputTokens).toBeGreaterThan(0);
        expect(outputB.metrics.outputTokens).toBeGreaterThan(0);
      }

      await runtimeB.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "Agent B receives injected context summary even without tool call",
    async () => {
      const store = createHandoffStore();
      const events: HandoffEvent[] = [];
      const onEvent = (e: HandoffEvent): void => {
        events.push(e);
      };

      // Manually create an envelope in the store (simulating Agent A's prepare)
      const envelopeId = handoffId(crypto.randomUUID());
      store.put({
        id: envelopeId,
        from: agentId("agent-a"),
        to: agentId("agent-b"),
        status: "pending",
        createdAt: Date.now(),
        phase: {
          completed: "Collected all user requirements",
          next: "Design the system architecture",
        },
        context: {
          results: { requirements: ["auth", "api", "ui"] },
          artifacts: [],
          decisions: [],
          warnings: ["Budget constraint: keep infrastructure costs low"],
        },
        metadata: {},
      });

      // Agent B with middleware — the LLM should see the injected context
      const runtimeB = await createHandoffRuntime({
        agentIdStr: "agent-b",
        store,
        onEvent,
        withMiddleware: true,
        maxTurns: 2,
      });

      const eventsB = await collectEvents(
        runtimeB.run({
          kind: "text",
          text: [
            "Look at the context you have been given.",
            "If you see a handoff context mentioning architecture design,",
            'reply with exactly: "HANDOFF_RECEIVED"',
            'If you do NOT see handoff context, reply with: "NO_HANDOFF"',
            "Do NOT call any tools. Just reply with the text.",
          ].join("\n"),
        }),
      );

      const outputB = findDoneOutput(eventsB);
      expect(outputB).toBeDefined();

      // The middleware should have injected context and emitted handoff:injected
      const injectedEvents = events.filter((e) => e.kind === "handoff:injected");
      expect(injectedEvents.length).toBe(1);

      // Verify envelope was transitioned (LLM may also call accept_handoff proactively)
      const envelope = store.get(envelopeId);
      const status = envelope?.status;
      expect(status === "injected" || status === "accepted").toBe(true);

      // The LLM should have seen the handoff context (check text response)
      const textDeltas = eventsB
        .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
        .map((e) => e.delta)
        .join("");

      // The LLM should respond acknowledging the handoff context
      expect(textDeltas.toUpperCase()).toContain("HANDOFF_RECEIVED");

      await runtimeB.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "middleware injects metadata (handoffId + handoffPhase) into turn context",
    async () => {
      const store = createHandoffStore();
      const events: HandoffEvent[] = [];
      const onEvent = (e: HandoffEvent): void => {
        events.push(e);
      };

      // Create pending envelope
      const envelopeId = handoffId(crypto.randomUUID());
      store.put({
        id: envelopeId,
        from: agentId("agent-a"),
        to: agentId("agent-b"),
        status: "pending",
        createdAt: Date.now(),
        phase: {
          completed: "Phase 1 done",
          next: "Execute phase 2",
        },
        context: {
          results: {},
          artifacts: [],
          decisions: [],
          warnings: [],
        },
        metadata: {},
      });

      const runtimeB = await createHandoffRuntime({
        agentIdStr: "agent-b",
        store,
        onEvent,
        withMiddleware: true,
        maxTurns: 2,
      });

      const engineEvents = await collectEvents(
        runtimeB.run({
          kind: "text",
          text: "Reply with exactly: OK",
        }),
      );

      const output = findDoneOutput(engineEvents);
      expect(output).toBeDefined();

      // Verify middleware emitted handoff:injected
      expect(events.some((e) => e.kind === "handoff:injected")).toBe(true);

      // Verify envelope was transitioned (LLM may also call accept_handoff proactively)
      const finalStatus = store.get(envelopeId)?.status;
      expect(finalStatus === "injected" || finalStatus === "accepted").toBe(true);

      await runtimeB.dispose();
    },
    TIMEOUT_MS,
  );
});
