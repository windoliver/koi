/**
 * SQLite pipeline integration test — simulates process restart mid-pipeline.
 *
 * Agent A prepares -> close DB -> reopen -> Agent B accepts
 */

import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HandoffEvent, JsonObject, ModelResponse } from "@koi/core";
import { agentId, handoffId } from "@koi/core";
import { createMockTurnContext } from "@koi/test-utils";
import { createAcceptTool } from "../accept-tool.js";
import { createHandoffMiddleware } from "../middleware.js";
import { createPrepareTool } from "../prepare-tool.js";
import { createSqliteHandoffStore } from "../sqlite-store.js";

const MOCK_RESPONSE: ModelResponse = { content: "ok", model: "test" };

describe("SQLite pipeline with restart", () => {
  const tmpPath = join(tmpdir(), `koi-handoff-pipeline-${Date.now()}.db`);

  afterEach(() => {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* noop */
    }
    try {
      unlinkSync(`${tmpPath}-wal`);
    } catch {
      /* noop */
    }
    try {
      unlinkSync(`${tmpPath}-shm`);
    } catch {
      /* noop */
    }
  });

  test("Agent A prepares, restart, Agent B accepts via SQLite", async () => {
    const events: HandoffEvent[] = [];
    const onEvent = (e: HandoffEvent): void => {
      events.push(e);
    };

    // -----------------------------------------------------------------------
    // Phase 1: Agent A prepares handoff
    // -----------------------------------------------------------------------
    const store1 = createSqliteHandoffStore({ dbPath: tmpPath });

    const prepareA = createPrepareTool({
      store: store1,
      agentId: agentId("agent-a"),
      onEvent,
    });

    const prepareResult = await prepareA.execute({
      to: "agent-b",
      completed: "Collected requirements",
      next: "Design architecture",
      results: { requirements: ["auth", "api"] },
    } as JsonObject);

    const envelopeId = (prepareResult as { handoffId: string }).handoffId;
    expect(envelopeId).toBeDefined();

    // Simulate process shutdown
    store1.close();

    // -----------------------------------------------------------------------
    // Phase 2: Process restarts — Agent B picks up from SQLite
    // -----------------------------------------------------------------------
    const store2 = createSqliteHandoffStore({ dbPath: tmpPath });

    // Middleware detects pending envelope
    const middlewareB = createHandoffMiddleware({
      store: store2,
      agentId: agentId("agent-b"),
      onEvent,
    });

    const ctxB = createMockTurnContext();
    await middlewareB.onBeforeTurn?.(ctxB);

    const metaB = ctxB.metadata as Record<string, unknown>;
    expect(metaB.handoffId).toBe(envelopeId);
    expect(metaB.handoffPhase).toBe("Design architecture");

    // wrapModelCall injects summary
    await middlewareB.wrapModelCall?.(
      ctxB,
      { messages: [], model: "test" },
      async () => MOCK_RESPONSE,
    );

    // Agent B accepts
    const acceptB = createAcceptTool({
      store: store2,
      agentId: agentId("agent-b"),
      onEvent,
    });

    const acceptResult = (await acceptB.execute({
      handoff_id: envelopeId,
    } as JsonObject)) as Record<string, unknown>;

    expect(acceptResult.handoffId).toBe(envelopeId);
    expect(acceptResult.results).toEqual({ requirements: ["auth", "api"] });
    expect(acceptResult.phase).toEqual({
      completed: "Collected requirements",
      next: "Design architecture",
    });

    // Verify status
    const getResult = await store2.get(handoffId(envelopeId));
    expect(getResult.ok).toBe(true);
    if (getResult.ok) {
      expect(getResult.value.status).toBe("accepted");
    }

    store2.close();
  });
});
