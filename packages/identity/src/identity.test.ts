/**
 * Unit tests for createIdentityMiddleware — dispatch paths and reload behaviors.
 */

import { describe, expect, it, mock, spyOn } from "bun:test";
import type {
  CapabilityFragment,
  ModelRequest,
  ModelResponse,
  TurnContext,
} from "@koi/core/middleware";
import { createIdentityMiddleware } from "./identity.js";
import * as personaMapModule from "./persona-map.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTurnCtx(channelId?: string): TurnContext {
  return {
    session: {
      agentId: "agent-1",
      sessionId: "session:agent:agent-1:abc" as import("@koi/core/ecs").SessionId,
      runId: "run-uuid" as import("@koi/core/ecs").RunId,
      ...(channelId !== undefined ? { channelId } : {}),
      metadata: {},
    },
    turnIndex: 0,
    turnId: "turn-uuid" as import("@koi/core/ecs").TurnId,
    messages: [],
    metadata: {},
  };
}

function makeModelRequest(overrides?: Partial<ModelRequest>): ModelRequest {
  return {
    messages: [
      {
        senderId: "user",
        timestamp: 1000,
        content: [{ kind: "text", text: "Hello" }],
      },
    ],
    ...overrides,
  };
}

const MOCK_RESPONSE: ModelResponse = {
  content: "Hi there",
  model: "test-model",
};

// ── Dispatch path tests ───────────────────────────────────────────────────────

describe("createIdentityMiddleware — dispatch paths", () => {
  it("1. channelId matches → system message prepended with name + instructions", async () => {
    const mw = await createIdentityMiddleware({
      personas: [
        {
          channelId: "@koi/channel-telegram",
          name: "Alex",
          instructions: "Be casual and friendly.",
        },
      ],
    });

    const captured: ModelRequest[] = [];
    const next = mock(async (req: ModelRequest) => {
      captured.push(req);
      return MOCK_RESPONSE;
    });

    const ctx = makeTurnCtx("@koi/channel-telegram");
    await mw.wrapModelCall(ctx, makeModelRequest(), next);

    expect(captured).toHaveLength(1);
    const req = captured[0];
    expect(req?.messages).toHaveLength(2); // injected + original
    const first = req?.messages[0];
    expect(first?.senderId).toBe("system:identity");
    if (first?.content[0]?.kind === "text") {
      expect(first.content[0].text).toContain("You are Alex.");
      expect(first.content[0].text).toContain("Be casual and friendly.");
    }
  });

  it("2. channelId matches, name only → name injected without instructions separator", async () => {
    const mw = await createIdentityMiddleware({
      personas: [{ channelId: "@koi/channel-telegram", name: "Research Bot" }],
    });

    const captured: ModelRequest[] = [];
    const next = mock(async (req: ModelRequest) => {
      captured.push(req);
      return MOCK_RESPONSE;
    });

    await mw.wrapModelCall(makeTurnCtx("@koi/channel-telegram"), makeModelRequest(), next);

    const first = captured[0]?.messages[0];
    expect(first?.senderId).toBe("system:identity");
    if (first?.content[0]?.kind === "text") {
      expect(first.content[0].text).toBe("You are Research Bot.");
    }
  });

  it("3. channelId present, no matching persona → request unchanged (no-op)", async () => {
    const mw = await createIdentityMiddleware({
      personas: [{ channelId: "@koi/channel-slack", name: "Alex" }],
    });

    const captured: ModelRequest[] = [];
    const next = mock(async (req: ModelRequest) => {
      captured.push(req);
      return MOCK_RESPONSE;
    });

    const original = makeModelRequest();
    await mw.wrapModelCall(makeTurnCtx("@koi/channel-telegram"), original, next);

    // Exact same request — no system message prepended
    expect(captured[0]).toBe(original);
  });

  it("4. channelId absent (undefined) → request unchanged (no-op)", async () => {
    const mw = await createIdentityMiddleware({
      personas: [{ channelId: "@koi/channel-telegram", name: "Alex" }],
    });

    const captured: ModelRequest[] = [];
    const next = mock(async (req: ModelRequest) => {
      captured.push(req);
      return MOCK_RESPONSE;
    });

    const original = makeModelRequest();
    await mw.wrapModelCall(makeTurnCtx(undefined), original, next);

    expect(captured[0]).toBe(original);
  });
});

// ── wrapModelStream dispatch paths ───────────────────────────────────────────

describe("createIdentityMiddleware — wrapModelStream dispatch", () => {
  it("injects system message in stream path when channelId matches", async () => {
    const mw = await createIdentityMiddleware({
      personas: [{ channelId: "@koi/channel-telegram", name: "Alex", instructions: "Be helpful." }],
    });

    const chunk = { kind: "done" as const, response: MOCK_RESPONSE };

    async function* mockStream(req: ModelRequest) {
      // Verify message was prepended
      expect(req.messages[0]?.senderId).toBe("system:identity");
      yield chunk;
    }

    const ctx = makeTurnCtx("@koi/channel-telegram");
    const stream = mw.wrapModelStream(ctx, makeModelRequest(), mockStream);
    const results: unknown[] = [];
    for await (const c of stream) {
      results.push(c);
    }
    expect(results).toHaveLength(1);
  });

  it("passes request unchanged in stream path when no matching persona", async () => {
    const mw = await createIdentityMiddleware({
      personas: [{ channelId: "@koi/channel-slack", name: "Alex" }],
    });

    const original = makeModelRequest();
    let captured: ModelRequest | undefined;

    async function* mockStream(req: ModelRequest) {
      captured = req;
      yield { kind: "done" as const, response: MOCK_RESPONSE };
    }

    const ctx = makeTurnCtx("@koi/channel-telegram");
    for await (const _ of mw.wrapModelStream(ctx, original, mockStream)) {
      // consume
    }

    expect(captured).toBe(original);
  });
});

// ── Reload behavior tests ─────────────────────────────────────────────────────

describe("createIdentityMiddleware — reload behaviors", () => {
  it("5. After reload(), next wrapModelCall uses new persona", async () => {
    const personas = [{ channelId: "@koi/channel-telegram", instructions: "Old instructions." }];
    const mw = await createIdentityMiddleware({ personas });

    // Mutate the personas array reference for reload — simulate updated config
    // by spying on buildPersonaMap to return a new map after reload
    const newMap = new Map<string, import("./persona-map.js").CachedPersona>();
    newMap.set("@koi/channel-telegram", {
      message: {
        senderId: "system:identity",
        timestamp: Date.now(),
        content: [{ kind: "text", text: "New instructions." }],
      },
      sources: [],
    });

    const spy = spyOn(personaMapModule, "buildPersonaMap").mockResolvedValueOnce(newMap);
    await mw.reload();
    spy.mockRestore();

    const captured: ModelRequest[] = [];
    const next = mock(async (req: ModelRequest) => {
      captured.push(req);
      return MOCK_RESPONSE;
    });

    await mw.wrapModelCall(makeTurnCtx("@koi/channel-telegram"), makeModelRequest(), next);

    const injected = captured[0]?.messages[0];
    if (injected?.content[0]?.kind === "text") {
      expect(injected.content[0].text).toBe("New instructions.");
    }
  });

  it("6. wrapToolCall: fs_write to tracked file → reload() called and persona updates", async () => {
    const tmpFile = "/tmp/koi-identity-test-persona.md";
    await Bun.write(tmpFile, "Original instructions.");

    const mw = await createIdentityMiddleware({
      personas: [{ channelId: "@koi/channel-telegram", instructions: { path: tmpFile } }],
    });

    // Verify original instruction is used
    const capturedBefore: ModelRequest[] = [];
    await mw.wrapModelCall(
      makeTurnCtx("@koi/channel-telegram"),
      makeModelRequest(),
      async (req) => {
        capturedBefore.push(req);
        return MOCK_RESPONSE;
      },
    );
    const firstText = capturedBefore[0]?.messages[0]?.content[0];
    if (firstText?.kind === "text") {
      expect(firstText.text).toContain("Original instructions.");
    }

    // Update the file and trigger via fs_write
    await Bun.write(tmpFile, "Updated instructions.");

    const writeNext = mock(async (_req: import("@koi/core/middleware").ToolRequest) => ({
      output: "ok",
    }));
    await mw.wrapToolCall(
      makeTurnCtx("@koi/channel-telegram"),
      { toolId: "fs_write", input: { path: tmpFile, content: "Updated instructions." } },
      writeNext,
    );

    // After fs_write, next model call should use updated persona
    const capturedAfter: ModelRequest[] = [];
    await mw.wrapModelCall(
      makeTurnCtx("@koi/channel-telegram"),
      makeModelRequest(),
      async (req) => {
        capturedAfter.push(req);
        return MOCK_RESPONSE;
      },
    );
    const updatedText = capturedAfter[0]?.messages[0]?.content[0];
    if (updatedText?.kind === "text") {
      expect(updatedText.text).toContain("Updated instructions.");
    }
  });

  it("7. wrapToolCall: fs_write to untracked file → reload() NOT called", async () => {
    const mw = await createIdentityMiddleware({
      personas: [{ channelId: "@koi/channel-telegram", instructions: "Inline instructions." }],
    });

    const spy = spyOn(personaMapModule, "buildPersonaMap");
    const next = mock(async (_req: import("@koi/core/middleware").ToolRequest) => ({
      output: "ok",
    }));

    const ctx = makeTurnCtx("@koi/channel-telegram");
    await mw.wrapToolCall(
      ctx,
      { toolId: "fs_write", input: { path: "/some/untracked/file.md", content: "x" } },
      next,
    );

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("8. wrapToolCall: non-fs_write tool → reload() NOT called", async () => {
    const tmpFile = "/tmp/koi-identity-test-persona-2.md";
    await Bun.write(tmpFile, "Persona.");

    const mw = await createIdentityMiddleware({
      personas: [{ channelId: "@koi/channel-telegram", instructions: { path: tmpFile } }],
    });

    const spy = spyOn(personaMapModule, "buildPersonaMap");
    const next = mock(async (_req: import("@koi/core/middleware").ToolRequest) => ({
      output: "ok",
    }));

    const ctx = makeTurnCtx("@koi/channel-telegram");
    await mw.wrapToolCall(ctx, { toolId: "bash", input: { command: "echo hello" } }, next);

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ── Middleware metadata ───────────────────────────────────────────────────────

describe("createIdentityMiddleware — metadata", () => {
  it("has name 'identity'", async () => {
    const mw = await createIdentityMiddleware({ personas: [] });
    expect(mw.name).toBe("identity");
  });

  it("has priority 490", async () => {
    const mw = await createIdentityMiddleware({ personas: [] });
    expect(mw.priority).toBe(490);
  });

  it("exposes reload function", async () => {
    const mw = await createIdentityMiddleware({ personas: [] });
    expect(typeof mw.reload).toBe("function");
  });
});

describe("describeCapabilities", () => {
  it("is defined on the middleware", async () => {
    const mw = await createIdentityMiddleware({ personas: [] });
    expect(mw.describeCapabilities).toBeDefined();
  });

  it("returns label 'identity' and description containing 'persona'", async () => {
    const mw = await createIdentityMiddleware({
      personas: [
        { channelId: "@koi/channel-telegram", name: "Alex" },
        { channelId: "@koi/channel-slack", name: "Bot" },
      ],
    });
    const ctx = makeTurnCtx();
    const result = mw.describeCapabilities?.(ctx) as CapabilityFragment;
    expect(result.label).toBe("identity");
    expect(result.description).toContain("persona");
  });
});
