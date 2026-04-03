/**
 * End-to-end test: Temporal Entity Workflow → Pi adapter → OpenRouter → real LLM.
 *
 * This test verifies the full chain:
 *   Temporal Worker → Entity Workflow → Activity → createKoi() → Pi engine → OpenRouter API
 *
 * Prerequisites:
 * - Temporal CLI installed (`temporal server start-dev`)
 * - OPENROUTER_API_KEY set (loaded from ~/nexus/.env)
 *
 * Run: TEMPORAL_E2E=true bun test src/__tests__/e2e-openrouter.test.ts
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Gate: only run when TEMPORAL_E2E=true
// ---------------------------------------------------------------------------

const SKIP = process.env.TEMPORAL_E2E !== "true";

/** Load OPENROUTER_API_KEY from ~/nexus/.env */
function loadEnvFile(): Record<string, string> {
  const envPath = join(homedir(), "nexus", ".env");
  try {
    const content = readFileSync(envPath, "utf-8");
    const result: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

describe.skipIf(SKIP)("E2E: Temporal + Pi + OpenRouter", () => {
  test("full round-trip: signal → Activity → createKoi → Pi → OpenRouter → result", async () => {
    const env = loadEnvFile();
    const apiKey = env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY;
    if (apiKey === undefined) {
      throw new Error("OPENROUTER_API_KEY not found in ~/nexus/.env or process.env");
    }

    // --- 1. Dynamic imports (heavy native deps) ---
    const { NativeConnection, Worker } = await import("@temporalio/worker");
    const { Client, Connection } = await import("@temporalio/client");
    const { createPiAdapter } = await import("@koi/engine-pi");
    const { createKoi } = await import("@koi/engine");
    const { heartbeat } = await import("@temporalio/activity");

    // --- 2. Connect to Temporal server ---
    const nativeConn = await NativeConnection.connect({
      address: "localhost:7233",
    });

    const clientConn = await Connection.connect({
      address: "localhost:7233",
    });

    const client = new Client({ connection: clientConn });

    // --- 3. Create real Activity that calls createKoi + Pi ---
    const activities = {
      async runAgentTurn(input: {
        readonly agentId: string;
        readonly sessionId: string;
        readonly message: {
          readonly id: string;
          readonly senderId: string;
          readonly content: readonly unknown[];
          readonly timestamp: number;
        };
        readonly stateRefs: {
          readonly lastTurnId: string | undefined;
          readonly turnsProcessed: number;
        };
        readonly gatewayUrl: string | undefined;
      }): Promise<{
        readonly turnId: string;
        readonly blocks: readonly { readonly kind: string; readonly text: string }[];
        readonly updatedStateRefs: {
          readonly lastTurnId: string;
          readonly turnsProcessed: number;
        };
        readonly spawnChild: undefined;
      }> {
        const adapter = createPiAdapter({
          model: "openrouter:anthropic/claude-3.5-haiku",
          systemPrompt: "You are a test assistant. Reply concisely.",
          getApiKey: async () => apiKey,
        });

        const runtime = await createKoi({
          manifest: {
            name: "temporal-e2e-test",
            version: "0.1.0",
            model: { name: "openrouter:anthropic/claude-3.5-haiku" },
          } as never,
          adapter: adapter as never,
          loopDetection: false,
        } as never);

        const blocks: { readonly kind: string; readonly text: string }[] = [];
        const turnId = `turn:${Date.now()}`;
        let eventCount = 0;

        // Extract text from message content
        const textContent = input.message.content
          .filter(
            (c): c is { kind: string; text: string } =>
              typeof c === "object" && c !== null && "text" in c,
          )
          .map((c) => c.text)
          .join("\n");

        const engineInput = {
          kind: "text" as const,
          text: textContent || "Say exactly: temporal-e2e-ok",
        };

        for await (const event of runtime.run(engineInput as never)) {
          const evt = event as { readonly kind: string; readonly delta?: string };
          if (evt.kind === "text_delta" && evt.delta !== undefined) {
            blocks.push({ kind: "text", text: evt.delta });
          }
          eventCount++;
          if (eventCount % 5 === 0) {
            heartbeat({ eventsProcessed: eventCount });
          }
        }

        await runtime.dispose();

        return {
          turnId,
          blocks,
          updatedStateRefs: {
            lastTurnId: turnId,
            turnsProcessed: input.stateRefs.turnsProcessed + 1,
          },
          spawnChild: undefined,
        };
      },
    };

    // --- 4. Create Worker ---
    const taskQueue = `e2e-openrouter-${Date.now()}`;
    const worker = await Worker.create({
      connection: nativeConn,
      taskQueue,
      workflowsPath: join(import.meta.dir, "../../dist/workflows/agent-workflow.js"),
      activities,
      maxCachedWorkflows: 1,
    });

    const workerPromise = worker.run();

    try {
      // --- 5. Start Entity Workflow ---
      const workflowId = `e2e-${Date.now()}`;
      const handle = await client.workflow.start("agentWorkflow", {
        taskQueue,
        workflowId,
        args: [
          {
            agentId: "e2e-agent",
            sessionId: workflowId,
            stateRefs: {
              lastTurnId: undefined,
              turnsProcessed: 0,
            },
          },
        ],
      });

      // --- 6. Signal with a message ---
      await handle.signal("message", {
        id: `msg-${Date.now()}`,
        senderId: "test-user",
        content: [{ kind: "text", text: "Reply with exactly: temporal-e2e-ok" }],
        timestamp: Date.now(),
      });

      // --- 7. Wait for the workflow to process the message ---
      // Poll the state query to check turnsProcessed
      let turnsProcessed = 0;
      const deadline = Date.now() + 60_000; // 60s timeout
      while (turnsProcessed === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2_000));
        try {
          const state = await handle.query("getState");
          const s = state as { turnsProcessed: number };
          turnsProcessed = s.turnsProcessed;
        } catch {
          // Query may fail while activity is running
        }
      }

      expect(turnsProcessed).toBeGreaterThan(0);

      // --- 8. Query status (should be idle after processing) ---
      const status = await handle.query("getStatus");
      expect(status).toBe("idle");

      // --- 9. Shutdown ---
      await handle.signal("shutdown", { reason: "test complete" });

      // Wait for workflow to complete
      await handle.result();

      console.log(
        `✅ E2E passed: Temporal workflow processed ${turnsProcessed} turn(s) with real OpenRouter LLM`,
      );
    } finally {
      worker.shutdown();
      await workerPromise;
      await nativeConn.close();
    }
  }, 120_000); // 2 minute timeout for real LLM call
});
