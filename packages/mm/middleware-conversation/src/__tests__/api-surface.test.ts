import { describe, expect, test } from "bun:test";
import { CONVERSATION_DEFAULTS } from "../config.js";
import { createConversationMiddleware } from "../conversation-middleware.js";

describe("API surface", () => {
  const store = {
    listMessages: () => ({ ok: true as const, value: [] }),
    appendAndCheckpoint: () => ({ ok: true as const, value: undefined }),
    loadThread: () => ({ ok: true as const, value: undefined }),
    close: () => {},
  };

  const mw = createConversationMiddleware({ store });

  test("createConversationMiddleware returns KoiMiddleware", () => {
    expect(mw).toBeDefined();
    expect(typeof mw.name).toBe("string");
  });

  test("name is 'koi:conversation'", () => {
    expect(mw.name).toBe("koi:conversation");
  });

  test("priority is 100", () => {
    expect(mw.priority).toBe(100);
  });

  test("phase is 'resolve'", () => {
    expect(mw.phase).toBe("resolve");
  });

  test("has onSessionStart hook", () => {
    expect(mw.onSessionStart).toBeDefined();
    expect(typeof mw.onSessionStart).toBe("function");
  });

  test("has wrapModelCall hook", () => {
    expect(mw.wrapModelCall).toBeDefined();
    expect(typeof mw.wrapModelCall).toBe("function");
  });

  test("has wrapModelStream hook", () => {
    expect(mw.wrapModelStream).toBeDefined();
    expect(typeof mw.wrapModelStream).toBe("function");
  });

  test("has onSessionEnd hook", () => {
    expect(mw.onSessionEnd).toBeDefined();
    expect(typeof mw.onSessionEnd).toBe("function");
  });

  test("has describeCapabilities hook", () => {
    expect(mw.describeCapabilities).toBeDefined();
    expect(typeof mw.describeCapabilities).toBe("function");
  });

  test("CONVERSATION_DEFAULTS has expected values", () => {
    expect(CONVERSATION_DEFAULTS.maxHistoryTokens).toBe(4_096);
    expect(CONVERSATION_DEFAULTS.maxMessages).toBe(200);
    expect(Object.isFrozen(CONVERSATION_DEFAULTS)).toBe(true);
  });
});
