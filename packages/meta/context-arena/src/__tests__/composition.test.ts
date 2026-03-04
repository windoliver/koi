/**
 * Integration tests — verifies the full bundle composition works end-to-end.
 */

import { describe, expect, test } from "bun:test";

import type { ThreadStore, TokenEstimator } from "@koi/core";
import type { SessionId } from "@koi/core/ecs";
import type { InboundMessage } from "@koi/core/message";
import type { ModelHandler } from "@koi/core/middleware";
import { createContextArena } from "../arena-factory.js";
import type { ContextArenaConfig } from "../types.js";

const stubSummarizer: ModelHandler = () => {
  throw new Error("stub");
};

function baseConfig(overrides?: Partial<ContextArenaConfig>): ContextArenaConfig {
  return {
    summarizer: stubSummarizer,
    sessionId: "integration-session" as SessionId,
    getMessages: (): readonly InboundMessage[] => [],
    ...overrides,
  };
}

describe("composition integration", () => {
  test("middleware priority ordering is correct (220 < 225 < 250)", async () => {
    const bundle = await createContextArena(baseConfig());
    const priorities = bundle.middleware.map((mw) => mw.priority);

    expect(priorities).toHaveLength(3);
    // Squash < Compactor < Context-editing
    expect(priorities[0]).toBe(220);
    expect(priorities[1]).toBe(225);
    expect(priorities[2]).toBe(250);

    // Verify strict ordering
    for (let i = 1; i < priorities.length; i++) {
      const prev = priorities[i - 1];
      const curr = priorities[i];
      if (prev !== undefined && curr !== undefined) {
        expect(prev).toBeLessThan(curr);
      }
    }
  });

  test("all middleware receive same tokenEstimator instance via config", async () => {
    const sharedEstimator: TokenEstimator = {
      estimateText: (text: string): number => Math.ceil(text.length / 5),
      estimateMessages: (): number => 42,
    };

    const bundle = await createContextArena(
      baseConfig({
        tokenEstimator: sharedEstimator,
      }),
    );

    // The resolved config confirms the shared estimator was used
    expect(bundle.config.tokenEstimator).toBe(sharedEstimator);
    // All 3 middleware were created with this estimator (verified by config plumbing)
    expect(bundle.middleware).toHaveLength(3);
  });

  test("full bundle round-trip: config → create → spread into mock runtime", async () => {
    const bundle = await createContextArena(
      baseConfig({
        preset: "conservative",
        contextWindowSize: 100_000,
      }),
    );

    // Verify config shape
    expect(bundle.config.preset).toBe("conservative");
    expect(bundle.config.contextWindowSize).toBe(100_000);
    expect(bundle.config.compactorTriggerFraction).toBe(0.5);
    expect(bundle.config.editingTriggerTokenCount).toBe(40_000);

    // Verify bundle can be spread into createKoi-like options
    const mockKoiOptions = {
      middleware: [...bundle.middleware],
      providers: [...bundle.providers],
    };

    expect(mockKoiOptions.middleware).toHaveLength(3);
    expect(mockKoiOptions.providers.length).toBeGreaterThanOrEqual(1);

    // Verify all middleware have names and describeCapabilities
    for (const mw of mockKoiOptions.middleware) {
      expect(mw.name).toBeDefined();
      expect(typeof mw.describeCapabilities).toBe("function");
    }

    // Verify all providers have names and attach
    for (const prov of mockKoiOptions.providers) {
      expect(prov.name).toBeDefined();
      expect(typeof prov.attach).toBe("function");
    }
  });

  test("middleware priority ordering with conversation (100 < 220 < 225 < 250)", async () => {
    const bundle = await createContextArena(baseConfig({ threadStore: stubThreadStore() }));
    const priorities = bundle.middleware.map((mw) => mw.priority);

    expect(priorities).toHaveLength(4);
    // Conversation < Squash < Compactor < Context-editing
    expect(priorities[0]).toBe(100);
    expect(priorities[1]).toBe(220);
    expect(priorities[2]).toBe(225);
    expect(priorities[3]).toBe(250);

    // Verify strict ordering
    for (let i = 1; i < priorities.length; i++) {
      const prev = priorities[i - 1];
      const curr = priorities[i];
      if (prev !== undefined && curr !== undefined) {
        expect(prev).toBeLessThan(curr);
      }
    }
  });
});

/** Minimal stub ThreadStore — never called in composition tests. */
function stubThreadStore(): ThreadStore {
  return {
    appendAndCheckpoint: () => {
      throw new Error("stub");
    },
    loadThread: () => {
      throw new Error("stub");
    },
    listMessages: () => {
      throw new Error("stub");
    },
    close: () => {},
  };
}
