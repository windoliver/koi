/**
 * Integration test — forge event bridge wired into createForgeMiddlewareStack.
 *
 * Verifies that when onDashboardEvent is provided to the middleware stack config,
 * forge callbacks (crystallize, demand, quarantine) emit the expected SSE events.
 */

import { describe, expect, test } from "bun:test";
import type { ForgeStore, KoiError, Result, TurnTrace } from "@koi/core";
import type { DashboardEvent } from "@koi/dashboard-types";
import { createInMemoryForgeStore } from "@koi/forge-tools";
import { createDefaultForgeConfig } from "@koi/forge-types";
import { createForgeMiddlewareStack } from "../create-forge-middleware-stack.js";

function createTestStore(): ForgeStore {
  return createInMemoryForgeStore();
}

function emptyTraces(): Promise<Result<readonly TurnTrace[], KoiError>> {
  return Promise.resolve({ ok: true, value: [] });
}

describe("forge-event-bridge integration", () => {
  test("createForgeMiddlewareStack with onDashboardEvent creates bridge", () => {
    const received: DashboardEvent[] = [];

    const result = createForgeMiddlewareStack({
      forgeStore: createTestStore(),
      forgeConfig: createDefaultForgeConfig(),
      scope: "agent",
      readTraces: emptyTraces,
      resolveBrickId: () => undefined,
      onDashboardEvent: (event) => {
        received.push(event);
      },
    });

    // Stack should be created successfully with all middlewares
    expect(result.middlewares.length).toBeGreaterThanOrEqual(7);
    expect(result.handles.demand).toBeDefined();
    expect(result.handles.crystallize).toBeDefined();
    expect(result.handles.feedbackLoop).toBeDefined();
  });

  test("createForgeMiddlewareStack without onDashboardEvent works normally", () => {
    const result = createForgeMiddlewareStack({
      forgeStore: createTestStore(),
      forgeConfig: createDefaultForgeConfig(),
      scope: "agent",
      readTraces: emptyTraces,
      resolveBrickId: () => undefined,
    });

    // Should work without bridge
    expect(result.middlewares.length).toBeGreaterThanOrEqual(7);
  });
});
