import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelRequest } from "@koi/core";
import type { CapabilityFragment, TurnContext } from "@koi/core/middleware";
import { createMockTurnContext, createSpyModelHandler } from "@koi/test-utils";
import type { SoulMiddleware } from "./soul.js";
import { createSoulMiddleware, enrichRequest } from "./soul.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = join(import.meta.dir, "__test_tmp__", crypto.randomUUID());
  await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/** Creates a TurnContext with a specific channelId. */
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

// ---------------------------------------------------------------------------
// enrichRequest — pure function
// ---------------------------------------------------------------------------

describe("enrichRequest", () => {
  test("returns request unchanged when soulMessage is undefined", () => {
    const request: ModelRequest = {
      messages: [{ senderId: "user", timestamp: 1, content: [{ kind: "text", text: "hi" }] }],
    };
    const result = enrichRequest(request, undefined);
    expect(result).toBe(request);
  });

  test("prepends soulMessage to messages", () => {
    const request: ModelRequest = {
      messages: [{ senderId: "user", timestamp: 1, content: [{ kind: "text", text: "hi" }] }],
    };
    const soulMessage = {
      senderId: "system:soul",
      timestamp: 0,
      content: [{ kind: "text" as const, text: "I am helpful." }],
    };
    const result = enrichRequest(request, soulMessage);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toBe(soulMessage);
    expect(result.messages[1]).toBe(request.messages[0]);
  });

  test("does not mutate original request", () => {
    const request: ModelRequest = {
      messages: [{ senderId: "user", timestamp: 1, content: [{ kind: "text", text: "hi" }] }],
    };
    const soulMessage = {
      senderId: "system:soul",
      timestamp: 0,
      content: [{ kind: "text" as const, text: "soul" }],
    };
    enrichRequest(request, soulMessage);
    expect(request.messages).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// createSoulMiddleware — factory basics
// ---------------------------------------------------------------------------

describe("createSoulMiddleware — factory", () => {
  test("returns middleware with name 'soul'", async () => {
    const mw = await createSoulMiddleware({ basePath: tmpDir });
    expect(mw.name).toBe("soul");
  });

  test("returns middleware with priority 500", async () => {
    const mw = await createSoulMiddleware({ basePath: tmpDir });
    expect(mw.priority).toBe(500);
  });

  test("defines wrapToolCall for auto-reload", async () => {
    const mw = await createSoulMiddleware({ basePath: tmpDir });
    expect(mw.wrapToolCall).toBeDefined();
  });

  test("no-op when no layers configured", async () => {
    const mw = await createSoulMiddleware({ basePath: tmpDir });
    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    const request: ModelRequest = {
      messages: [{ senderId: "user", timestamp: 1, content: [{ kind: "text", text: "hello" }] }],
    };

    await mw.wrapModelCall?.(ctx, request, spy.handler);

    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]).toBe(request);
  });

  test("SoulMiddleware type is assignable from createSoulMiddleware", async () => {
    const mw: SoulMiddleware = await createSoulMiddleware({ basePath: tmpDir });
    expect(mw.name).toBe("soul");
    expect(typeof mw.reload).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Soul layer only
// ---------------------------------------------------------------------------

describe("createSoulMiddleware — soul layer", () => {
  test("prepends soul content to messages", async () => {
    await writeFile(join(tmpDir, "SOUL.md"), "I am a wise assistant.");

    const mw = await createSoulMiddleware({ soul: "SOUL.md", basePath: tmpDir });
    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(
      ctx,
      { messages: [{ senderId: "user", timestamp: 1, content: [{ kind: "text", text: "hi" }] }] },
      spy.handler,
    );

    expect(spy.calls).toHaveLength(1);
    const enriched = spy.calls[0];
    expect(enriched?.messages).toHaveLength(2);
    expect(enriched?.messages[0]?.senderId).toBe("system:soul");
    if (enriched?.messages[0]?.content[0]?.kind === "text") {
      expect(enriched.messages[0].content[0].text).toContain("I am a wise assistant.");
    }
  });

  test("accepts inline soul content", async () => {
    const mw = await createSoulMiddleware({
      soul: "Inline soul\nWith multiple lines",
      basePath: tmpDir,
    });
    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(
      ctx,
      { messages: [{ senderId: "user", timestamp: 1, content: [{ kind: "text", text: "hi" }] }] },
      spy.handler,
    );

    const soulMsg = spy.calls[0]?.messages[0];
    if (soulMsg?.content[0]?.kind === "text") {
      expect(soulMsg.content[0].text).toContain("Inline soul");
    }
  });
});

// ---------------------------------------------------------------------------
// Identity layer only
// ---------------------------------------------------------------------------

describe("createSoulMiddleware — identity layer", () => {
  test("injects persona when channelId matches", async () => {
    const mw = await createSoulMiddleware({
      identity: {
        personas: [
          { channelId: "@koi/channel-telegram", name: "Alex", instructions: "Be casual." },
        ],
      },
      basePath: tmpDir,
    });
    const ctx = makeTurnCtx("@koi/channel-telegram");
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(
      ctx,
      { messages: [{ senderId: "user", timestamp: 1, content: [{ kind: "text", text: "hi" }] }] },
      spy.handler,
    );

    const msg = spy.calls[0]?.messages[0];
    expect(msg?.senderId).toBe("system:soul");
    if (msg?.content[0]?.kind === "text") {
      expect(msg.content[0].text).toContain("You are Alex.");
      expect(msg.content[0].text).toContain("Be casual.");
    }
  });

  test("no-op when channelId does not match", async () => {
    const mw = await createSoulMiddleware({
      identity: {
        personas: [{ channelId: "@koi/channel-slack", name: "Alex" }],
      },
      basePath: tmpDir,
    });
    const ctx = makeTurnCtx("@koi/channel-telegram");
    const spy = createSpyModelHandler();
    const request: ModelRequest = {
      messages: [{ senderId: "user", timestamp: 1, content: [{ kind: "text", text: "hi" }] }],
    };
    await mw.wrapModelCall?.(ctx, request, spy.handler);

    // No enrichment — request passed through unchanged
    expect(spy.calls[0]).toBe(request);
  });

  test("no-op when channelId is absent", async () => {
    const mw = await createSoulMiddleware({
      identity: {
        personas: [{ channelId: "@koi/channel-telegram", name: "Alex" }],
      },
      basePath: tmpDir,
    });
    const ctx = makeTurnCtx(undefined);
    const spy = createSpyModelHandler();
    const request: ModelRequest = {
      messages: [{ senderId: "user", timestamp: 1, content: [{ kind: "text", text: "hi" }] }],
    };
    await mw.wrapModelCall?.(ctx, request, spy.handler);

    expect(spy.calls[0]).toBe(request);
  });
});

// ---------------------------------------------------------------------------
// Three-layer interaction tests
// ---------------------------------------------------------------------------

describe("createSoulMiddleware — layer interactions", () => {
  test("1. all three layers — correct concatenation order (soul, identity, user)", async () => {
    await writeFile(join(tmpDir, "SOUL.md"), "I am helpful.");
    await writeFile(join(tmpDir, "USER.md"), "User prefers dark mode.");

    const mw = await createSoulMiddleware({
      soul: "SOUL.md",
      identity: {
        personas: [
          { channelId: "@koi/channel-telegram", name: "Alex", instructions: "Be casual." },
        ],
      },
      user: "USER.md",
      basePath: tmpDir,
    });
    const ctx = makeTurnCtx("@koi/channel-telegram");
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(
      ctx,
      { messages: [{ senderId: "user", timestamp: 1, content: [{ kind: "text", text: "hi" }] }] },
      spy.handler,
    );

    const msg = spy.calls[0]?.messages[0];
    if (msg?.content[0]?.kind === "text") {
      const text = msg.content[0].text;
      const soulIdx = text.indexOf("I am helpful.");
      const identityIdx = text.indexOf("You are Alex.");
      const userIdx = text.indexOf("User prefers dark mode.");
      expect(soulIdx).toBeGreaterThanOrEqual(0);
      expect(identityIdx).toBeGreaterThan(soulIdx);
      expect(userIdx).toBeGreaterThan(identityIdx);
    }
  });

  test("2. identity miss + soul+user — soul + user only", async () => {
    await writeFile(join(tmpDir, "SOUL.md"), "I am helpful.");
    await writeFile(join(tmpDir, "USER.md"), "User context.");

    const mw = await createSoulMiddleware({
      soul: "SOUL.md",
      identity: {
        personas: [{ channelId: "@koi/channel-slack", name: "Slack Bot" }],
      },
      user: "USER.md",
      basePath: tmpDir,
    });
    const ctx = makeTurnCtx("@koi/channel-telegram"); // no match
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(
      ctx,
      { messages: [{ senderId: "user", timestamp: 1, content: [{ kind: "text", text: "hi" }] }] },
      spy.handler,
    );

    const msg = spy.calls[0]?.messages[0];
    if (msg?.content[0]?.kind === "text") {
      const text = msg.content[0].text;
      expect(text).toContain("I am helpful.");
      expect(text).toContain("User context.");
      expect(text).not.toContain("Slack Bot");
    }
  });

  test("3. soul + identity only (no user)", async () => {
    await writeFile(join(tmpDir, "SOUL.md"), "I am helpful.");

    const mw = await createSoulMiddleware({
      soul: "SOUL.md",
      identity: {
        personas: [{ channelId: "@koi/channel-telegram", name: "Alex" }],
      },
      basePath: tmpDir,
    });
    const ctx = makeTurnCtx("@koi/channel-telegram");
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(
      ctx,
      { messages: [{ senderId: "user", timestamp: 1, content: [{ kind: "text", text: "hi" }] }] },
      spy.handler,
    );

    const msg = spy.calls[0]?.messages[0];
    if (msg?.content[0]?.kind === "text") {
      expect(msg.content[0].text).toContain("I am helpful.");
      expect(msg.content[0].text).toContain("You are Alex.");
    }
  });

  test("4. identity + user only (no soul)", async () => {
    await writeFile(join(tmpDir, "USER.md"), "User context.");

    const mw = await createSoulMiddleware({
      identity: {
        personas: [{ channelId: "@koi/channel-telegram", name: "Alex" }],
      },
      user: "USER.md",
      basePath: tmpDir,
    });
    const ctx = makeTurnCtx("@koi/channel-telegram");
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(
      ctx,
      { messages: [{ senderId: "user", timestamp: 1, content: [{ kind: "text", text: "hi" }] }] },
      spy.handler,
    );

    const msg = spy.calls[0]?.messages[0];
    if (msg?.content[0]?.kind === "text") {
      expect(msg.content[0].text).toContain("You are Alex.");
      expect(msg.content[0].text).toContain("User context.");
    }
  });

  test("5. empty layers skipped in concatenation (no extra separators)", async () => {
    await writeFile(join(tmpDir, "SOUL.md"), "Soul only.");

    const mw = await createSoulMiddleware({
      soul: "SOUL.md",
      basePath: tmpDir,
      selfModify: false,
    });
    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(
      ctx,
      { messages: [{ senderId: "user", timestamp: 1, content: [{ kind: "text", text: "hi" }] }] },
      spy.handler,
    );

    const msg = spy.calls[0]?.messages[0];
    if (msg?.content[0]?.kind === "text") {
      // Should just be "Soul only." without leading/trailing \n\n
      expect(msg.content[0].text).toBe("Soul only.");
    }
  });
});

// ---------------------------------------------------------------------------
// wrapModelStream
// ---------------------------------------------------------------------------

describe("createSoulMiddleware — wrapModelStream", () => {
  test("prepends soul content in stream calls", async () => {
    await writeFile(join(tmpDir, "SOUL.md"), "Stream soul.");

    const mw = await createSoulMiddleware({ soul: "SOUL.md", basePath: tmpDir });
    const ctx = createMockTurnContext();

    let capturedRequest: ModelRequest | undefined;
    const mockStreamHandler = async function* (req: ModelRequest) {
      capturedRequest = req;
      yield { kind: "text_delta" as const, delta: "hello" };
      yield {
        kind: "done" as const,
        response: { content: "hello", model: "test-model" },
      };
    };

    const stream = mw.wrapModelStream?.(
      ctx,
      { messages: [{ senderId: "user", timestamp: 1, content: [{ kind: "text", text: "hi" }] }] },
      mockStreamHandler,
    );

    if (stream) {
      for await (const _chunk of stream) {
        // consume
      }
    }

    expect(capturedRequest).toBeDefined();
    expect(capturedRequest?.messages).toHaveLength(2);
    expect(capturedRequest?.messages[0]?.senderId).toBe("system:soul");
  });
});

// ---------------------------------------------------------------------------
// refreshUser
// ---------------------------------------------------------------------------

describe("createSoulMiddleware — refreshUser", () => {
  test("re-reads user content on each call when refreshUser is true", async () => {
    await writeFile(join(tmpDir, "SOUL.md"), "Soul text.");
    await writeFile(join(tmpDir, "USER.md"), "Version 1");

    const mw = await createSoulMiddleware({
      soul: "SOUL.md",
      user: "USER.md",
      basePath: tmpDir,
      refreshUser: true,
    });
    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    const request: ModelRequest = {
      messages: [{ senderId: "user", timestamp: 1, content: [{ kind: "text", text: "hi" }] }],
    };

    await mw.wrapModelCall?.(ctx, request, spy.handler);
    const firstMsg = spy.calls[0]?.messages[0];
    if (firstMsg?.content[0]?.kind === "text") {
      expect(firstMsg.content[0].text).toContain("Version 1");
    }

    await writeFile(join(tmpDir, "USER.md"), "Version 2");
    await mw.wrapModelCall?.(ctx, request, spy.handler);
    const secondMsg = spy.calls[1]?.messages[0];
    if (secondMsg?.content[0]?.kind === "text") {
      expect(secondMsg.content[0].text).toContain("Version 2");
    }
  });

  test("refreshUser with identity — user refreshed, identity cached", async () => {
    await writeFile(join(tmpDir, "USER.md"), "User v1");

    const mw = await createSoulMiddleware({
      identity: {
        personas: [{ channelId: "@koi/channel-telegram", name: "Alex" }],
      },
      user: "USER.md",
      basePath: tmpDir,
      refreshUser: true,
    });
    const ctx = makeTurnCtx("@koi/channel-telegram");
    const spy = createSpyModelHandler();
    const request: ModelRequest = {
      messages: [{ senderId: "user", timestamp: 1, content: [{ kind: "text", text: "hi" }] }],
    };

    await mw.wrapModelCall?.(ctx, request, spy.handler);
    if (spy.calls[0]?.messages[0]?.content[0]?.kind === "text") {
      expect(spy.calls[0].messages[0].content[0].text).toContain("User v1");
      expect(spy.calls[0].messages[0].content[0].text).toContain("You are Alex.");
    }

    await writeFile(join(tmpDir, "USER.md"), "User v2");
    await mw.wrapModelCall?.(ctx, request, spy.handler);
    if (spy.calls[1]?.messages[0]?.content[0]?.kind === "text") {
      expect(spy.calls[1].messages[0].content[0].text).toContain("User v2");
      expect(spy.calls[1].messages[0].content[0].text).toContain("You are Alex.");
    }
  });
});

// ---------------------------------------------------------------------------
// reload()
// ---------------------------------------------------------------------------

describe("createSoulMiddleware — reload", () => {
  test("exposes reload method", async () => {
    const mw = await createSoulMiddleware({ basePath: tmpDir });
    expect(typeof mw.reload).toBe("function");
  });

  test("reload picks up soul file changes", async () => {
    await writeFile(join(tmpDir, "SOUL.md"), "Version A");

    const mw = await createSoulMiddleware({ soul: "SOUL.md", basePath: tmpDir });
    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    const request: ModelRequest = {
      messages: [{ senderId: "user", timestamp: 1, content: [{ kind: "text", text: "hi" }] }],
    };

    await mw.wrapModelCall?.(ctx, request, spy.handler);
    if (spy.calls[0]?.messages[0]?.content[0]?.kind === "text") {
      expect(spy.calls[0].messages[0].content[0].text).toContain("Version A");
    }

    await writeFile(join(tmpDir, "SOUL.md"), "Version B");

    // Without reload — still Version A
    await mw.wrapModelCall?.(ctx, request, spy.handler);
    if (spy.calls[1]?.messages[0]?.content[0]?.kind === "text") {
      expect(spy.calls[1].messages[0].content[0].text).toContain("Version A");
    }

    // After reload — Version B
    await mw.reload();
    await mw.wrapModelCall?.(ctx, request, spy.handler);
    if (spy.calls[2]?.messages[0]?.content[0]?.kind === "text") {
      expect(spy.calls[2].messages[0].content[0].text).toContain("Version B");
    }
  });

  test("cross-layer reload — soul and identity files updated", async () => {
    await writeFile(join(tmpDir, "SOUL.md"), "Soul A");
    const personaFile = join(tmpDir, "persona.md");
    await writeFile(personaFile, "Persona A");

    const mw = await createSoulMiddleware({
      soul: "SOUL.md",
      identity: {
        personas: [{ channelId: "@koi/channel-telegram", instructions: { path: "persona.md" } }],
      },
      basePath: tmpDir,
    });
    const ctx = makeTurnCtx("@koi/channel-telegram");
    const spy = createSpyModelHandler();
    const request: ModelRequest = {
      messages: [{ senderId: "user", timestamp: 1, content: [{ kind: "text", text: "hi" }] }],
    };

    // Before — Soul A + Persona A
    await mw.wrapModelCall?.(ctx, request, spy.handler);
    if (spy.calls[0]?.messages[0]?.content[0]?.kind === "text") {
      expect(spy.calls[0].messages[0].content[0].text).toContain("Soul A");
      expect(spy.calls[0].messages[0].content[0].text).toContain("Persona A");
    }

    // Update both
    await writeFile(join(tmpDir, "SOUL.md"), "Soul B");
    await writeFile(personaFile, "Persona B");

    await mw.reload();
    await mw.wrapModelCall?.(ctx, request, spy.handler);
    if (spy.calls[1]?.messages[0]?.content[0]?.kind === "text") {
      expect(spy.calls[1].messages[0].content[0].text).toContain("Soul B");
      expect(spy.calls[1].messages[0].content[0].text).toContain("Persona B");
    }
  });

  test("identity persona swap on reload", async () => {
    const personaFile = join(tmpDir, "persona.md");
    await writeFile(personaFile, "Old instructions.");

    const mw = await createSoulMiddleware({
      identity: {
        personas: [{ channelId: "@koi/channel-telegram", instructions: { path: "persona.md" } }],
      },
      basePath: tmpDir,
    });
    const ctx = makeTurnCtx("@koi/channel-telegram");
    const spy = createSpyModelHandler();
    const request: ModelRequest = {
      messages: [{ senderId: "user", timestamp: 1, content: [{ kind: "text", text: "hi" }] }],
    };

    await mw.wrapModelCall?.(ctx, request, spy.handler);
    if (spy.calls[0]?.messages[0]?.content[0]?.kind === "text") {
      expect(spy.calls[0].messages[0].content[0].text).toContain("Old instructions.");
    }

    await writeFile(personaFile, "New instructions.");
    await mw.reload();
    await mw.wrapModelCall?.(ctx, request, spy.handler);
    if (spy.calls[1]?.messages[0]?.content[0]?.kind === "text") {
      expect(spy.calls[1].messages[0].content[0].text).toContain("New instructions.");
    }
  });
});

// ---------------------------------------------------------------------------
// wrapToolCall auto-reload
// ---------------------------------------------------------------------------

describe("createSoulMiddleware — wrapToolCall auto-reload", () => {
  test("auto-reloads after fs_write to tracked soul file", async () => {
    await writeFile(join(tmpDir, "SOUL.md"), "Original soul");

    const mw = await createSoulMiddleware({ soul: "SOUL.md", basePath: tmpDir });
    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    const request: ModelRequest = {
      messages: [{ senderId: "user", timestamp: 1, content: [{ kind: "text", text: "hi" }] }],
    };

    await mw.wrapModelCall?.(ctx, request, spy.handler);
    if (spy.calls[0]?.messages[0]?.content[0]?.kind === "text") {
      expect(spy.calls[0].messages[0].content[0].text).toContain("Original soul");
    }

    // Simulate fs_write to SOUL.md
    await writeFile(join(tmpDir, "SOUL.md"), "Updated soul via forge");
    const soulPath = join(tmpDir, "SOUL.md");

    const toolNext = async (_req: import("@koi/core").ToolRequest) => ({
      output: { ok: true },
    });
    await mw.wrapToolCall?.(ctx, { toolId: "fs_write", input: { path: soulPath } }, toolNext);

    await mw.wrapModelCall?.(ctx, request, spy.handler);
    if (spy.calls[1]?.messages[0]?.content[0]?.kind === "text") {
      expect(spy.calls[1].messages[0].content[0].text).toContain("Updated soul via forge");
    }
  });

  test("auto-reloads after fs_write to tracked identity file", async () => {
    const personaFile = join(tmpDir, "persona.md");
    await writeFile(personaFile, "Original persona.");

    const mw = await createSoulMiddleware({
      identity: {
        personas: [{ channelId: "@koi/channel-telegram", instructions: { path: "persona.md" } }],
      },
      basePath: tmpDir,
    });
    const ctx = makeTurnCtx("@koi/channel-telegram");
    const spy = createSpyModelHandler();
    const request: ModelRequest = {
      messages: [{ senderId: "user", timestamp: 1, content: [{ kind: "text", text: "hi" }] }],
    };

    await mw.wrapModelCall?.(ctx, request, spy.handler);
    if (spy.calls[0]?.messages[0]?.content[0]?.kind === "text") {
      expect(spy.calls[0].messages[0].content[0].text).toContain("Original persona.");
    }

    await writeFile(personaFile, "Updated persona.");
    const toolNext = async (_req: import("@koi/core").ToolRequest) => ({
      output: { ok: true },
    });
    await mw.wrapToolCall?.(ctx, { toolId: "fs_write", input: { path: personaFile } }, toolNext);

    await mw.wrapModelCall?.(ctx, request, spy.handler);
    if (spy.calls[1]?.messages[0]?.content[0]?.kind === "text") {
      expect(spy.calls[1].messages[0].content[0].text).toContain("Updated persona.");
    }
  });

  test("does NOT reload for fs_write to unrelated file", async () => {
    await writeFile(join(tmpDir, "SOUL.md"), "Original");

    const mw = await createSoulMiddleware({ soul: "SOUL.md", basePath: tmpDir });
    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    const request: ModelRequest = {
      messages: [{ senderId: "user", timestamp: 1, content: [{ kind: "text", text: "hi" }] }],
    };

    await writeFile(join(tmpDir, "SOUL.md"), "Sneaky update");

    const toolNext = async (_req: import("@koi/core").ToolRequest) => ({
      output: { ok: true },
    });
    await mw.wrapToolCall?.(
      ctx,
      { toolId: "fs_write", input: { path: "/some/other/file.txt" } },
      toolNext,
    );

    await mw.wrapModelCall?.(ctx, request, spy.handler);
    if (spy.calls[0]?.messages[0]?.content[0]?.kind === "text") {
      expect(spy.calls[0].messages[0].content[0].text).toContain("Original");
    }
  });

  test("does NOT reload for non-fs_write tool calls", async () => {
    await writeFile(join(tmpDir, "SOUL.md"), "Original");

    const mw = await createSoulMiddleware({ soul: "SOUL.md", basePath: tmpDir });
    const ctx = createMockTurnContext();

    await writeFile(join(tmpDir, "SOUL.md"), "Sneaky update");

    const toolNext = async (_req: import("@koi/core").ToolRequest) => ({
      output: { ok: true },
    });
    await mw.wrapToolCall?.(ctx, { toolId: "search", input: { query: "test" } }, toolNext);

    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(
      ctx,
      { messages: [{ senderId: "user", timestamp: 1, content: [{ kind: "text", text: "hi" }] }] },
      spy.handler,
    );

    if (spy.calls[0]?.messages[0]?.content[0]?.kind === "text") {
      expect(spy.calls[0].messages[0].content[0].text).toContain("Original");
    }
  });

  test("passes tool call through to next handler", async () => {
    const mw = await createSoulMiddleware({ basePath: tmpDir });
    const ctx = createMockTurnContext();

    let nextCalled = false;
    const toolNext = async (_req: import("@koi/core").ToolRequest) => {
      nextCalled = true;
      return { output: { result: "ok" } };
    };

    const response = await mw.wrapToolCall?.(
      ctx,
      { toolId: "search", input: { query: "test" } },
      toolNext,
    );

    expect(nextCalled).toBe(true);
    expect((response?.output as { result: string }).result).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// describeCapabilities
// ---------------------------------------------------------------------------

describe("describeCapabilities", () => {
  test("is defined on the middleware", async () => {
    const mw = await createSoulMiddleware({ basePath: tmpDir });
    expect(mw.describeCapabilities).toBeDefined();
  });

  test("returns label 'soul' and description containing 'Persona'", async () => {
    const mw = await createSoulMiddleware({ basePath: tmpDir });
    const ctx = createMockTurnContext();
    const result = mw.describeCapabilities?.(ctx) as CapabilityFragment;
    expect(result.label).toBe("soul");
    expect(result.description).toContain("Persona");
  });
});
