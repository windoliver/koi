/**
 * Unit tests for createPassthroughContextEngine — full-context, no-compaction
 * engine for short sessions or debugging (issue #1767, Phase 4).
 */

import { describe, expect, test } from "bun:test";
import type { InboundMessage } from "@koi/core/message";
import type { TurnContext } from "@koi/core/middleware";
import { createPassthroughContextEngine } from "./passthrough-context-engine.js";

const ctx = { metadata: {} } as unknown as TurnContext;

describe("createPassthroughContextEngine", () => {
  test("identity is stable and namespaced", () => {
    const engine = createPassthroughContextEngine();
    expect(engine.identity.name).toBe("@koi/context-manager/passthrough");
    expect(engine.identity.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("prepare returns the input list verbatim", async () => {
    const engine = createPassthroughContextEngine();
    const messages: readonly InboundMessage[] = [
      { senderId: "user", timestamp: 1, content: [{ kind: "text", text: "a" }] },
      { senderId: "assistant", timestamp: 2, content: [{ kind: "text", text: "b" }] },
    ];
    const out = await engine.prepare(ctx, messages);
    expect(out).toEqual(messages);
  });

  test("describeOccupancy is intentionally absent — passthrough has no budget signal", () => {
    const engine = createPassthroughContextEngine();
    expect(engine.describeOccupancy).toBeUndefined();
  });

  test("custom identity overrides the default", () => {
    const engine = createPassthroughContextEngine({
      identity: { name: "@custom/full", version: "0.1.0" },
    });
    expect(engine.identity.name).toBe("@custom/full");
  });
});
