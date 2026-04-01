/**
 * E2E: @koi/tool-browser SkillComponent with a real Playwright driver through
 * the full createKoi runtime.
 *
 * Verifies that:
 * 1. skill:browser is attached to the agent's component map when using a real
 *    Playwright-backed BrowserProvider.
 * 2. The skill content covers snapshot-first workflow, form filling, wait
 *    strategies, tab management, and trust tier awareness.
 * 3. The snapshot-act-re-snapshot pattern (browser_snapshot → browser_navigate
 *    → browser_snapshot) executes correctly through the full middleware stack
 *    against a real Chromium browser.
 *
 * Gated by TEST_BROWSER=1 environment variable.
 * Requires: bunx playwright install chromium
 *
 * Run: TEST_BROWSER=1 bun test tests/e2e/browser-skill.e2e.test.ts
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createPlaywrightBrowserDriver } from "@koi/browser-playwright";
import type {
  BrowserDriver,
  EngineEvent,
  KoiMiddleware,
  ModelRequest,
  ModelResponse,
  SkillComponent,
  ToolHandler,
  ToolRequest,
  ToolResponse,
} from "@koi/core";
import { skillToken } from "@koi/core";
import { createKoi } from "@koi/engine";
import { BROWSER_SKILL_NAME, createBrowserProvider } from "@koi/tool-browser";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const SKIP = !process.env.TEST_BROWSER;

const MODEL_NAME = "claude-haiku-4-5-20251001";
const TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const result: EngineEvent[] = []; // let justified: accumulator
  for await (const event of iterable) {
    result.push(event);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)(
  "e2e: @koi/tool-browser SkillComponent with real Playwright through full createKoi runtime",
  () => {
    let driver: BrowserDriver;
    let runtime: Awaited<ReturnType<typeof createKoi>> | undefined; // let justified: set per test

    beforeAll(async () => {
      driver = createPlaywrightBrowserDriver({ headless: true });
    });

    afterEach(async () => {
      await runtime?.dispose?.();
      runtime = undefined;
    });

    // afterAll: driver is shared — dispose after all tests complete
    // (browser-playwright integration tests share this pattern)

    test(
      "skill:browser is attached to agent component map alongside browser tools",
      async () => {
        const browserProvider = createBrowserProvider({ backend: driver });

        let _modelCallCount = 0; // let justified: tracks phase
        const modelCall = async (_request: ModelRequest): Promise<ModelResponse> => {
          _modelCallCount++;
          // Single phase: done immediately
          return {
            content: "Skill component verified.",
            model: MODEL_NAME,
            usage: { inputTokens: 5, outputTokens: 5 },
          };
        };

        const { createLoopAdapter } = await import("@koi/engine-loop");
        const adapter = createLoopAdapter({ modelCall, maxTurns: 3 });

        runtime = await createKoi({
          manifest: {
            name: "e2e-browser-skill-presence",
            version: "0.0.1",
            model: { name: MODEL_NAME },
          },
          adapter,
          providers: [browserProvider],
        });

        // Verify the skill is attached to the agent's component map
        const skill = runtime.agent.component<SkillComponent>(skillToken(BROWSER_SKILL_NAME));
        expect(skill).toBeDefined();
        expect(skill?.name).toBe(BROWSER_SKILL_NAME);
        expect(skill?.description.length).toBeGreaterThan(0);
        expect(skill?.content.length).toBeGreaterThan(0);

        // Verify skill covers all key guidance areas
        expect(skill?.content).toContain("browser_snapshot");
        expect(skill?.content).toContain("snapshotId");
        expect(skill?.content).toContain("browser_fill_form");
        expect(skill?.content).toContain("browser_wait");
        expect(skill?.content).toContain("browser_tab_focus");
        expect(skill?.content).toContain("browser_evaluate");
        expect(skill?.content).toContain("promoted");

        // Agent completes without errors
        const events = await collectEvents(
          runtime.run({ kind: "text", text: "Check browser component map." }),
        );
        expect(events.find((e) => e.kind === "done")).toBeDefined();
      },
      TIMEOUT_MS,
    );

    test(
      "snapshot-act-snapshot workflow: navigate → snapshot → navigate → re-snapshot executes correctly",
      async () => {
        const browserProvider = createBrowserProvider({ backend: driver });

        const calledTools: string[] = []; // let justified: ordered call log
        const snapshotIds: string[] = []; // let justified: tracks snapshot IDs across phases
        let modelCallCount = 0; // let justified: tracks phase

        const toolObserver: KoiMiddleware = {
          name: "e2e-browser-skill-observer",
          wrapToolCall: async (
            _ctx,
            request: ToolRequest,
            next: ToolHandler,
          ): Promise<ToolResponse> => {
            calledTools.push(request.toolId);
            const result = await next(request);
            // Capture snapshotIds returned by successful browser_snapshot calls
            if (request.toolId === "browser_snapshot") {
              const output = result.output as { snapshotId?: string };
              if (output.snapshotId !== undefined) {
                snapshotIds.push(output.snapshotId);
              }
            }
            return result;
          },
        };

        const PAGE_A = "data:text/html,<h1>Page%20A</h1><button>Continue</button>";
        const PAGE_B = "data:text/html,<h1>Page%20B</h1><button>Submit</button>";

        const modelCall = async (_request: ModelRequest): Promise<ModelResponse> => {
          modelCallCount++;

          if (modelCallCount === 1) {
            // Phase 1: navigate to starting page (browser needs a loaded page before snapshot)
            return {
              content: "Navigating to the starting page.",
              model: MODEL_NAME,
              usage: { inputTokens: 10, outputTokens: 10 },
              metadata: {
                toolCalls: [
                  { toolName: "browser_navigate", callId: "call-nav-1", input: { url: PAGE_A } },
                ],
              },
            };
          }

          if (modelCallCount === 2) {
            // Phase 2: snapshot first (skill says: always snapshot before acting)
            return {
              content: "Taking a snapshot to see the current page state.",
              model: MODEL_NAME,
              usage: { inputTokens: 20, outputTokens: 10 },
              metadata: {
                toolCalls: [{ toolName: "browser_snapshot", callId: "call-snap-1", input: {} }],
              },
            };
          }

          if (modelCallCount === 3) {
            // Phase 3: act — navigate to second page (DOM change)
            const latestSnapshotId = snapshotIds.at(-1);
            return {
              content: "Navigating to the next page.",
              model: MODEL_NAME,
              usage: { inputTokens: 40, outputTokens: 10 },
              metadata: {
                toolCalls: [
                  {
                    toolName: "browser_navigate",
                    callId: "call-nav-2",
                    input: {
                      url: PAGE_B,
                      ...(latestSnapshotId !== undefined ? { snapshotId: latestSnapshotId } : {}),
                    },
                  },
                ],
              },
            };
          }

          if (modelCallCount === 4) {
            // Phase 4: re-snapshot after DOM change (skill says: re-snapshot after navigation)
            return {
              content: "Re-taking snapshot after navigation to see the new page.",
              model: MODEL_NAME,
              usage: { inputTokens: 60, outputTokens: 10 },
              metadata: {
                toolCalls: [{ toolName: "browser_snapshot", callId: "call-snap-2", input: {} }],
              },
            };
          }

          // Phase 5: done
          return {
            content: "Snapshot-act-snapshot workflow completed successfully.",
            model: MODEL_NAME,
            usage: { inputTokens: 80, outputTokens: 10 },
          };
        };

        const { createLoopAdapter } = await import("@koi/engine-loop");
        const adapter = createLoopAdapter({ modelCall, maxTurns: 7 });

        runtime = await createKoi({
          manifest: {
            name: "e2e-browser-snapshot-workflow",
            version: "0.0.1",
            model: { name: MODEL_NAME },
          },
          adapter,
          middleware: [toolObserver],
          providers: [browserProvider],
        });

        const events = await collectEvents(
          runtime.run({ kind: "text", text: "Navigate to the test page and interact with it." }),
        );

        // Agent completed
        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();
        if (doneEvent?.kind === "done") {
          expect(doneEvent.output.stopReason).toBe("completed");
        }

        // Full workflow: navigate → snapshot → navigate → re-snapshot
        expect(calledTools).toEqual([
          "browser_navigate",
          "browser_snapshot",
          "browser_navigate",
          "browser_snapshot",
        ]);

        // Both snapshots returned valid snapshotIds
        expect(snapshotIds).toHaveLength(2);
        expect(snapshotIds[0]).toMatch(/^snap-tab-\d+-\d+$/);
        expect(snapshotIds[1]).toMatch(/^snap-tab-\d+-\d+$/);
        // snapshotIds may repeat after navigation (counter resets per tab) — that is correct
        // behavior; what matters is that both calls succeeded and the pattern was followed.

        // Skill is present on the agent
        const skill = runtime.agent.component<SkillComponent>(skillToken(BROWSER_SKILL_NAME));
        expect(skill).toBeDefined();
        expect(skill?.content).toContain("browser_snapshot");

        await driver.dispose?.();
      },
      TIMEOUT_MS,
    );
  },
);
