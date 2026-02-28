import { describe, expect, mock, test } from "bun:test";
import type { ModelRequest, ModelResponse, TurnContext } from "@koi/core";
import { createSkillActivatorMiddleware } from "./skill-activator-middleware.js";
import type { ProgressiveSkillProvider, SkillLoadLevel } from "./types.js";

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

function createMockProvider(
  knownSkills: ReadonlyMap<string, SkillLoadLevel>,
): ProgressiveSkillProvider & {
  readonly promoteCalls: Array<{
    readonly name: string;
    readonly level: SkillLoadLevel | undefined;
  }>;
} {
  const promoteCalls: Array<{ readonly name: string; readonly level: SkillLoadLevel | undefined }> =
    [];
  const levels = new Map(knownSkills);

  return {
    name: "@koi/skills",
    attach: mock(() => Promise.resolve({ components: new Map(), skipped: [] })),
    promote: mock(async (name: string, level?: SkillLoadLevel) => {
      promoteCalls.push({ name, level });
      if (levels.has(name)) {
        return { ok: true as const, value: undefined };
      }
      return {
        ok: false as const,
        error: {
          code: "NOT_FOUND" as const,
          message: `Skill "${name}" not found`,
          retryable: false,
        },
      };
    }),
    getLevel: (name: string) => levels.get(name),
    promoteCalls,
  };
}

const stubCtx = {} as unknown as TurnContext;

const stubResponse: ModelResponse = {
  content: "ok",
  model: "test",
};

function createRequest(texts: readonly string[]): ModelRequest {
  return {
    messages: texts.map((text) => ({
      content: [{ kind: "text" as const, text }],
      senderId: "user",
      timestamp: Date.now(),
    })),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSkillActivatorMiddleware", () => {
  test("returns middleware with correct name and priority", () => {
    const provider = createMockProvider(new Map());
    const mw = createSkillActivatorMiddleware({ provider });
    expect(mw.name).toBe("skill-activator");
    expect(mw.priority).toBe(200);
  });

  test("describeCapabilities returns undefined", () => {
    const provider = createMockProvider(new Map());
    const mw = createSkillActivatorMiddleware({ provider });
    expect(mw.describeCapabilities(stubCtx)).toBeUndefined();
  });

  test("promotes skill referenced in message text", async () => {
    const provider = createMockProvider(new Map([["code-review", "metadata"]]));
    const mw = createSkillActivatorMiddleware({ provider, targetLevel: "body" });

    const request = createRequest(["Please use skill:code-review to check my code."]);
    const next = mock(async (_req: ModelRequest) => stubResponse);

    await mw.wrapModelCall?.(stubCtx, request, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(provider.promoteCalls).toHaveLength(1);
    expect(provider.promoteCalls[0]?.name).toBe("code-review");
    expect(provider.promoteCalls[0]?.level).toBe("body");
  });

  test("promotes multiple distinct skills referenced in messages", async () => {
    const provider = createMockProvider(
      new Map([
        ["code-review", "metadata"],
        ["testing", "metadata"],
      ]),
    );
    const mw = createSkillActivatorMiddleware({ provider });

    const request = createRequest(["Use skill:code-review first.", "Then run skill:testing."]);
    const next = mock(async (_req: ModelRequest) => stubResponse);

    await mw.wrapModelCall?.(stubCtx, request, next);

    expect(provider.promoteCalls).toHaveLength(2);
    const promotedNames = provider.promoteCalls.map((c) => c.name);
    expect(promotedNames).toContain("code-review");
    expect(promotedNames).toContain("testing");
  });

  test("deduplicates same skill referenced multiple times in one text block", async () => {
    const provider = createMockProvider(new Map([["code-review", "metadata"]]));
    const mw = createSkillActivatorMiddleware({ provider });

    const request = createRequest(["skill:code-review and skill:code-review again"]);
    const next = mock(async (_req: ModelRequest) => stubResponse);

    await mw.wrapModelCall?.(stubCtx, request, next);

    expect(provider.promoteCalls).toHaveLength(1);
  });

  test("ignores skill references not in provider", async () => {
    const provider = createMockProvider(new Map());
    const mw = createSkillActivatorMiddleware({ provider });

    const request = createRequest(["Mentioning skill:unknown-thing here."]);
    const next = mock(async (_req: ModelRequest) => stubResponse);

    await mw.wrapModelCall?.(stubCtx, request, next);

    expect(provider.promoteCalls).toHaveLength(0);
  });

  test("ignores non-text content blocks", async () => {
    const provider = createMockProvider(new Map([["code-review", "metadata"]]));
    const mw = createSkillActivatorMiddleware({ provider });

    const request: ModelRequest = {
      messages: [
        {
          content: [
            { kind: "image", url: "https://example.com/img.png" },
            { kind: "file", url: "https://example.com/f.txt", mimeType: "text/plain" },
          ],
          senderId: "user",
          timestamp: Date.now(),
        },
      ],
    };
    const next = mock(async (_req: ModelRequest) => stubResponse);

    await mw.wrapModelCall?.(stubCtx, request, next);

    expect(provider.promoteCalls).toHaveLength(0);
  });

  test("does not block the model call", async () => {
    const provider = createMockProvider(new Map([["code-review", "metadata"]]));
    const mw = createSkillActivatorMiddleware({ provider });

    const request = createRequest(["skill:code-review"]);
    const next = mock(async (_req: ModelRequest) => stubResponse);

    const result = await mw.wrapModelCall?.(stubCtx, request, next);

    expect(result).toBe(stubResponse);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("uses default targetLevel of body", async () => {
    const provider = createMockProvider(new Map([["code-review", "metadata"]]));
    const mw = createSkillActivatorMiddleware({ provider });

    const request = createRequest(["skill:code-review"]);
    const next = mock(async (_req: ModelRequest) => stubResponse);

    await mw.wrapModelCall?.(stubCtx, request, next);

    expect(provider.promoteCalls[0]?.level).toBe("body");
  });
});
