import { describe, expect, test } from "bun:test";

import type { SessionId } from "@koi/core/ecs";
import type { InboundMessage } from "@koi/core/message";
import type { ModelHandler } from "@koi/core/middleware";
import { createContextArenaEntries } from "./registry-adapter.js";

const stubSummarizer: ModelHandler = () => {
  throw new Error("stub");
};

const baseConfig = {
  summarizer: stubSummarizer,
  sessionId: "test-session" as SessionId,
  getMessages: (): readonly InboundMessage[] => [],
};

describe("createContextArenaEntries", () => {
  test("entries map contains 'context-arena' key", () => {
    const { entries } = createContextArenaEntries(baseConfig);
    expect(entries.has("context-arena")).toBe(true);
    expect(entries.size).toBe(1);
  });

  test("factory returns valid middleware from manifest config", async () => {
    const { entries } = createContextArenaEntries(baseConfig);
    const factory = entries.get("context-arena");
    expect(factory).toBeDefined();
    if (factory === undefined) return;

    const middleware = await factory({
      name: "context-arena",
      options: { preset: "aggressive", contextWindowSize: 100_000 },
    });
    expect(middleware).toBeDefined();
    expect(middleware.priority).toBe(225); // compactor priority
  });

  test("bundle accessible after factory invocation", async () => {
    const { entries, getBundle } = createContextArenaEntries(baseConfig);
    expect(getBundle()).toBeUndefined();

    const factory = entries.get("context-arena");
    if (factory === undefined) return;
    await factory({ name: "context-arena", options: {} });

    const bundle = getBundle();
    expect(bundle).toBeDefined();
    expect(bundle?.middleware).toHaveLength(3);
    expect(bundle?.providers.length).toBeGreaterThanOrEqual(1);
  });
});
