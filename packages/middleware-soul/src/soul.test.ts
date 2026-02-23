import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelRequest } from "@koi/core";
import { createMockTurnContext, createSpyModelHandler } from "@koi/test-utils";
import { createSoulMiddleware, enrichRequest } from "./soul.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = join(import.meta.dir, "__test_tmp__", crypto.randomUUID());
  await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

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
// createSoulMiddleware — factory
// ---------------------------------------------------------------------------

describe("createSoulMiddleware", () => {
  test("returns middleware with name 'soul'", async () => {
    const mw = await createSoulMiddleware({ basePath: tmpDir });
    expect(mw.name).toBe("soul");
  });

  test("returns middleware with priority 500", async () => {
    const mw = await createSoulMiddleware({ basePath: tmpDir });
    expect(mw.priority).toBe(500);
  });

  test("does not define wrapToolCall", async () => {
    const mw = await createSoulMiddleware({ basePath: tmpDir });
    expect(mw.wrapToolCall).toBeUndefined();
  });

  test("no-op when no soul or user configured", async () => {
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
});

// ---------------------------------------------------------------------------
// createSoulMiddleware — wrapModelCall
// ---------------------------------------------------------------------------

describe("createSoulMiddleware — wrapModelCall", () => {
  test("prepends soul content to messages", async () => {
    await writeFile(join(tmpDir, "SOUL.md"), "I am a wise assistant.");

    const mw = await createSoulMiddleware({
      soul: "SOUL.md",
      basePath: tmpDir,
    });
    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    const request: ModelRequest = {
      messages: [{ senderId: "user", timestamp: 1, content: [{ kind: "text", text: "hi" }] }],
    };

    await mw.wrapModelCall?.(ctx, request, spy.handler);

    expect(spy.calls).toHaveLength(1);
    const enriched = spy.calls[0];
    expect(enriched?.messages).toHaveLength(2);
    expect(enriched?.messages[0]?.senderId).toBe("system:soul");
    if (enriched?.messages[0]?.content[0]?.kind === "text") {
      expect(enriched.messages[0].content[0].text).toContain("I am a wise assistant.");
    }
  });

  test("soul content at position 0 in messages array", async () => {
    await writeFile(join(tmpDir, "SOUL.md"), "Soul text");

    const mw = await createSoulMiddleware({
      soul: "SOUL.md",
      basePath: tmpDir,
    });
    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(
      ctx,
      { messages: [{ senderId: "user", timestamp: 1, content: [{ kind: "text", text: "hi" }] }] },
      spy.handler,
    );

    expect(spy.calls[0]?.messages[0]?.senderId).toBe("system:soul");
  });

  test("combines soul + user content in correct order", async () => {
    await writeFile(join(tmpDir, "SOUL.md"), "I am helpful.");
    await writeFile(join(tmpDir, "USER.md"), "User prefers short answers.");

    const mw = await createSoulMiddleware({
      soul: "SOUL.md",
      user: "USER.md",
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
      const text = soulMsg.content[0].text;
      const soulIdx = text.indexOf("I am helpful.");
      const userIdx = text.indexOf("User prefers short answers.");
      expect(soulIdx).toBeGreaterThanOrEqual(0);
      expect(userIdx).toBeGreaterThan(soulIdx);
    }
  });

  test("soul only — no user section in message", async () => {
    await writeFile(join(tmpDir, "SOUL.md"), "Just soul.");

    const mw = await createSoulMiddleware({
      soul: "SOUL.md",
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
      expect(soulMsg.content[0].text).toBe("Just soul.");
    }
  });

  test("user only — no soul section in message", async () => {
    await writeFile(join(tmpDir, "USER.md"), "Just user.");

    const mw = await createSoulMiddleware({
      user: "USER.md",
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
      expect(soulMsg.content[0].text).toBe("Just user.");
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
// createSoulMiddleware — wrapModelStream
// ---------------------------------------------------------------------------

describe("createSoulMiddleware — wrapModelStream", () => {
  test("prepends soul content in stream calls", async () => {
    await writeFile(join(tmpDir, "SOUL.md"), "Stream soul.");

    const mw = await createSoulMiddleware({
      soul: "SOUL.md",
      basePath: tmpDir,
    });
    const ctx = createMockTurnContext();

    // Track what request the stream handler receives
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

    // Consume the stream
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
// createSoulMiddleware — refreshUser
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

    // First call — should see "Version 1"
    await mw.wrapModelCall?.(ctx, request, spy.handler);
    const firstMsg = spy.calls[0]?.messages[0];
    if (firstMsg?.content[0]?.kind === "text") {
      expect(firstMsg.content[0].text).toContain("Version 1");
    }

    // Update the user file
    await writeFile(join(tmpDir, "USER.md"), "Version 2");

    // Second call — should see "Version 2"
    await mw.wrapModelCall?.(ctx, request, spy.handler);
    const secondMsg = spy.calls[1]?.messages[0];
    if (secondMsg?.content[0]?.kind === "text") {
      expect(secondMsg.content[0].text).toContain("Version 2");
    }
  });
});

// ---------------------------------------------------------------------------
// createSoulMiddleware — integration
// ---------------------------------------------------------------------------

describe("createSoulMiddleware — integration", () => {
  test("middleware chain with spy handler verifies ordering", async () => {
    await writeFile(join(tmpDir, "SOUL.md"), "Be kind.");
    await writeFile(join(tmpDir, "USER.md"), "Name: Bob");

    const mw = await createSoulMiddleware({
      soul: "SOUL.md",
      user: "USER.md",
      basePath: tmpDir,
    });

    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();

    // Simulate two turns
    const request1: ModelRequest = {
      messages: [{ senderId: "user", timestamp: 1, content: [{ kind: "text", text: "Turn 1" }] }],
    };
    const request2: ModelRequest = {
      messages: [{ senderId: "user", timestamp: 2, content: [{ kind: "text", text: "Turn 2" }] }],
    };

    await mw.wrapModelCall?.(ctx, request1, spy.handler);
    await mw.wrapModelCall?.(ctx, request2, spy.handler);

    expect(spy.calls).toHaveLength(2);

    // Both calls should have soul message prepended
    for (const call of spy.calls) {
      expect(call?.messages[0]?.senderId).toBe("system:soul");
      if (call?.messages[0]?.content[0]?.kind === "text") {
        expect(call.messages[0].content[0].text).toContain("Be kind.");
        expect(call.messages[0].content[0].text).toContain("Name: Bob");
      }
    }
  });
});
