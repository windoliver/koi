/**
 * Integration test — simulates a 3-agent pipeline with handoff envelopes.
 *
 * Agent A → prepare_handoff → Agent B → accept + prepare → Agent C → accept
 */

import { describe, expect, test } from "bun:test";
import type { HandoffEvent, JsonObject, ModelResponse } from "@koi/core";
import { agentId, handoffId } from "@koi/core";
import { createMockTurnContext } from "@koi/test-utils";
import { createAcceptTool } from "../accept-tool.js";
import { createHandoffMiddleware } from "../middleware.js";
import { createPrepareTool } from "../prepare-tool.js";
import { createHandoffStore } from "../store.js";

const MOCK_RESPONSE: ModelResponse = { content: "ok", model: "test" };

describe("3-agent pipeline integration", () => {
  test("envelopes flow through A → B → C with correct status transitions", async () => {
    const store = createHandoffStore();
    const events: HandoffEvent[] = [];
    const onEvent = (e: HandoffEvent): void => {
      events.push(e);
    };

    // -----------------------------------------------------------------------
    // Agent A: prepare handoff for B
    // -----------------------------------------------------------------------
    const prepareA = createPrepareTool({
      store,
      agentId: agentId("agent-a"),
      onEvent,
    });

    const prepareResult = await prepareA.execute({
      to: "agent-b",
      completed: "Collected user requirements",
      next: "Design the architecture based on requirements",
      results: { requirements: ["auth", "api", "ui"] },
      artifacts: [{ id: "req-doc", kind: "file", uri: "file:///workspace/requirements.md" }],
      decisions: [
        {
          agentId: "agent-a",
          action: "chose_framework",
          reasoning: "React is best for this use case",
          timestamp: Date.now(),
        },
      ],
      warnings: ["Budget constraint: keep it simple"],
    } as JsonObject);

    const envelopeIdAB = (prepareResult as { handoffId: string }).handoffId;
    expect(envelopeIdAB).toBeDefined();
    expect(events[0]?.kind).toBe("handoff:prepared");

    // -----------------------------------------------------------------------
    // Agent B: middleware injects summary, then accept + prepare for C
    // -----------------------------------------------------------------------
    const middlewareB = createHandoffMiddleware({
      store,
      agentId: agentId("agent-b"),
      onEvent,
    });

    // Simulate first model call — middleware injects summary
    const ctxB = createMockTurnContext();
    await middlewareB.onBeforeTurn?.(ctxB);

    const metaB = ctxB.metadata as Record<string, unknown>;
    expect(metaB.handoffId).toBe(envelopeIdAB);
    expect(metaB.handoffPhase).toBe("Design the architecture based on requirements");

    // wrapModelCall injects summary
    let injectedRequest: { messages: readonly unknown[] } | undefined;
    await middlewareB.wrapModelCall?.(ctxB, { messages: [], model: "test" }, async (req) => {
      injectedRequest = req;
      return MOCK_RESPONSE;
    });

    expect(injectedRequest?.messages.length).toBe(1); // system message prepended
    expect(store.get(handoffId(envelopeIdAB))?.status).toBe("injected");

    // Agent B accepts the handoff
    const acceptB = createAcceptTool({
      store,
      agentId: agentId("agent-b"),
      onEvent,
    });

    const acceptResultB = (await acceptB.execute({
      handoff_id: envelopeIdAB,
    } as JsonObject)) as Record<string, unknown>;
    expect(acceptResultB.handoffId).toBe(envelopeIdAB);
    expect(acceptResultB.results).toEqual({ requirements: ["auth", "api", "ui"] });
    expect(store.get(handoffId(envelopeIdAB))?.status).toBe("accepted");

    // Agent B prepares handoff for C
    const prepareB = createPrepareTool({
      store,
      agentId: agentId("agent-b"),
      onEvent,
    });

    const prepareResultBC = await prepareB.execute({
      to: "agent-c",
      completed: "Designed architecture: microservices with API gateway",
      next: "Implement the architecture",
      results: {
        architecture: "microservices",
        services: ["auth-service", "api-gateway", "ui-service"],
      },
      warnings: [
        "Budget constraint: keep it simple",
        "Use existing auth library, don't build from scratch",
      ],
    } as JsonObject);

    const envelopeIdBC = (prepareResultBC as { handoffId: string }).handoffId;
    expect(envelopeIdBC).toBeDefined();

    // -----------------------------------------------------------------------
    // Agent C: middleware injects, then accept
    // -----------------------------------------------------------------------
    const middlewareC = createHandoffMiddleware({
      store,
      agentId: agentId("agent-c"),
      onEvent,
    });

    const ctxC = createMockTurnContext();
    await middlewareC.onBeforeTurn?.(ctxC);

    const metaC = ctxC.metadata as Record<string, unknown>;
    expect(metaC.handoffId).toBe(envelopeIdBC);

    // wrapModelCall injects summary
    await middlewareC.wrapModelCall?.(
      ctxC,
      { messages: [], model: "test" },
      async () => MOCK_RESPONSE,
    );

    expect(store.get(handoffId(envelopeIdBC))?.status).toBe("injected");

    // Agent C accepts
    const acceptC = createAcceptTool({
      store,
      agentId: agentId("agent-c"),
      onEvent,
    });

    const acceptResultC = (await acceptC.execute({
      handoff_id: envelopeIdBC,
    } as JsonObject)) as Record<string, unknown>;
    expect(acceptResultC.handoffId).toBe(envelopeIdBC);
    expect(acceptResultC.results).toEqual({
      architecture: "microservices",
      services: ["auth-service", "api-gateway", "ui-service"],
    });
    expect(store.get(handoffId(envelopeIdBC))?.status).toBe("accepted");

    // -----------------------------------------------------------------------
    // Verify event sequence
    // -----------------------------------------------------------------------
    const eventKinds = events.map((e) => e.kind);
    expect(eventKinds).toEqual([
      "handoff:prepared", // A prepares for B
      "handoff:injected", // B's middleware injects
      "handoff:accepted", // B accepts
      "handoff:prepared", // B prepares for C
      "handoff:injected", // C's middleware injects
      "handoff:accepted", // C accepts
    ]);

    // Verify warnings accumulated through pipeline
    const _cWarnings = (acceptResultC.warnings as readonly string[]) ?? [];
    // Agent B forwarded budget constraint + added its own warning
    const bEnvelope = store.get(handoffId(envelopeIdBC));
    expect(bEnvelope).toBeDefined();
    expect(bEnvelope?.context.warnings).toContain("Budget constraint: keep it simple");
    expect(bEnvelope?.context.warnings).toContain(
      "Use existing auth library, don't build from scratch",
    );
  });
});
