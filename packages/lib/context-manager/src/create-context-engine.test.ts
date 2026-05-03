/**
 * Unit tests for createContextEngine — default ContextEngine adapter (issue #1767).
 */

import { describe, expect, test } from "bun:test";
import type { ContextEngine } from "@koi/core/context-engine";
import type { InboundMessage } from "@koi/core/message";
import type { TurnContext } from "@koi/core/middleware";
import { createContextEngine, DEFAULT_CONTEXT_ENGINE_IDENTITY } from "./create-context-engine.js";

const ctx = { metadata: {} } as unknown as TurnContext;

describe("createContextEngine", () => {
  test("returns a ContextEngine with default identity", () => {
    const engine: ContextEngine = createContextEngine();
    expect(engine.identity).toEqual(DEFAULT_CONTEXT_ENGINE_IDENTITY);
    expect(engine.identity.name).toBe("@koi/context-manager");
  });

  test("identity name matches the package and is stable across instances", () => {
    const a = createContextEngine();
    const b = createContextEngine();
    expect(a.identity.name).toBe(b.identity.name);
    expect(a.identity.version).toBe(b.identity.version);
  });

  test("prepare on small message list returns input unchanged (noop)", async () => {
    const engine = createContextEngine();
    const messages: readonly InboundMessage[] = [
      { senderId: "user", timestamp: 0, content: [{ kind: "text", text: "hello" }] },
    ];
    const out = await engine.prepare(ctx, messages);
    expect(out).toEqual(messages);
  });

  test("prepare returns a new readonly array (never mutates input)", async () => {
    const engine = createContextEngine();
    const input: readonly InboundMessage[] = Object.freeze([
      { senderId: "user", timestamp: 0, content: [{ kind: "text", text: "hello" }] },
    ]);
    // Should not throw despite frozen input — engine MUST NOT mutate.
    const out = await engine.prepare(ctx, input);
    expect(Array.isArray(out)).toBe(true);
    expect(out.length).toBe(1);
  });

  test("describeOccupancy reports valid pressure invariants", async () => {
    const engine = createContextEngine({ contextWindowSize: 1000 });
    const occ = await engine.describeOccupancy?.();
    expect(occ).toBeDefined();
    expect(occ?.maxTokens).toBe(1000);
    expect(occ?.estimatedTokens).toBeGreaterThanOrEqual(0);
    expect(occ?.pressure).toBeGreaterThanOrEqual(0);
    expect(occ?.pressure).toBeLessThanOrEqual(1);
  });

  test("describeOccupancy pressure tracks recent message accounting via prepare", async () => {
    const engine = createContextEngine({ contextWindowSize: 1_000_000 });
    const before = await engine.describeOccupancy?.();
    expect(before?.estimatedTokens).toBe(0);
    await engine.prepare(ctx, [
      {
        senderId: "user",
        timestamp: 0,
        content: [{ kind: "text", text: "hello world".repeat(100) }],
      },
    ]);
    const after = await engine.describeOccupancy?.();
    expect(after?.estimatedTokens ?? 0).toBeGreaterThan(0);
  });

  test("custom identity overrides the default", () => {
    const engine = createContextEngine({
      identity: { name: "@my-org/my-engine", version: "9.9.9" },
    });
    expect(engine.identity.name).toBe("@my-org/my-engine");
    expect(engine.identity.version).toBe("9.9.9");
  });

  test("describeOccupancy reflects the messages prepare() actually emitted", async () => {
    // Regression: prior implementation read enforceBudget.totalTokens on the
    // "full" path, which is the PRE-compaction count. The engine MUST instead
    // report tokens of the list it actually returned — otherwise occupancy
    // lies whenever compaction trims the emitted list.
    const block = "lorem ipsum dolor sit amet ".repeat(20);
    const engine = createContextEngine({
      contextWindowSize: 5000,
      softTriggerFraction: 0.4,
    });
    const messages = Array.from({ length: 8 }, (_, i) => ({
      senderId: i % 2 === 0 ? "user" : "assistant",
      timestamp: i,
      content: [{ kind: "text" as const, text: `m${i}: ${block}` }],
    }));

    const out = await engine.prepare(ctx, messages);
    const occ = await engine.describeOccupancy?.();
    expect(occ).toBeDefined();
    // The reported estimate must be a function of the emitted list — not the
    // pre-prepare input. With FALLBACK_ESTIMATOR (chars/4), the count is
    // strictly proportional to the joined text length of `out`.
    const emittedChars = out.reduce(
      (n, m) => n + m.content.reduce((cn, c) => cn + (c.kind === "text" ? c.text.length : 0), 0),
      0,
    );
    expect(occ?.estimatedTokens ?? 0).toBeLessThanOrEqual(Math.ceil(emittedChars / 3));
    expect(occ?.estimatedTokens ?? 0).toBeGreaterThanOrEqual(Math.floor(emittedChars / 5));
  });
});
