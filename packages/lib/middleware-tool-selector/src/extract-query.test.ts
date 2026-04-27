import { describe, expect, test } from "bun:test";
import type { InboundMessage } from "@koi/core";
import { extractLastUserText } from "./extract-query.js";

function msg(blocks: InboundMessage["content"]): InboundMessage {
  return { content: blocks, senderId: "user", timestamp: 0 };
}

function asMsg(senderId: string, blocks: InboundMessage["content"]): InboundMessage {
  return { content: blocks, senderId, timestamp: 0 };
}

describe("extractLastUserText", () => {
  test("returns empty string when message list is empty", () => {
    expect(extractLastUserText([])).toBe("");
  });

  test("returns text of the last message's text blocks", () => {
    const messages: readonly InboundMessage[] = [
      msg([{ kind: "text", text: "first" }]),
      msg([{ kind: "text", text: "deploy the app" }]),
    ];
    expect(extractLastUserText(messages)).toBe("deploy the app");
  });

  test("joins multiple text blocks with a single space", () => {
    const messages: readonly InboundMessage[] = [
      msg([
        { kind: "text", text: "hello" },
        { kind: "text", text: "world" },
      ]),
    ];
    expect(extractLastUserText(messages)).toBe("hello world");
  });

  test("ignores non-text blocks", () => {
    const messages: readonly InboundMessage[] = [
      msg([
        { kind: "image", url: "https://example.com/x.png" },
        { kind: "text", text: "caption" },
      ]),
    ];
    expect(extractLastUserText(messages)).toBe("caption");
  });

  test("returns empty string when last message has no text blocks", () => {
    const messages: readonly InboundMessage[] = [
      msg([{ kind: "image", url: "https://example.com/x.png" }]),
    ];
    expect(extractLastUserText(messages)).toBe("");
  });

  test("walks back past assistant and tool messages to last user text", () => {
    const messages: readonly InboundMessage[] = [
      asMsg("user", [{ kind: "text", text: "deploy the app" }]),
      asMsg("assistant", [{ kind: "text", text: "running ls now" }]),
      asMsg("tool", [{ kind: "text", text: '{"files":["README.md"]}' }]),
    ];
    expect(extractLastUserText(messages)).toBe("deploy the app");
  });

  test("returns empty when no user message has text", () => {
    const messages: readonly InboundMessage[] = [
      asMsg("assistant", [{ kind: "text", text: "hello" }]),
      asMsg("tool", [{ kind: "text", text: "result" }]),
    ];
    expect(extractLastUserText(messages)).toBe("");
  });

  test("treats user-* sender ids as user-authored (multi-user / resumed transcripts)", () => {
    const messages: readonly InboundMessage[] = [
      asMsg("user-1", [{ kind: "text", text: "deploy the app" }]),
      asMsg("assistant", [{ kind: "text", text: "ok" }]),
    ];
    expect(extractLastUserText(messages)).toBe("deploy the app");
  });

  test("does not treat user-like prefixes from other senders as user (tool/system)", () => {
    const messages: readonly InboundMessage[] = [
      asMsg("usertool", [{ kind: "text", text: "fake user payload" }]),
      asMsg("system:something", [{ kind: "text", text: "system" }]),
    ];
    // None match the user-sender shape → no user text found.
    expect(extractLastUserText(messages)).toBe("");
  });

  test("recognizes channel-prefixed user sender ids (e.g. cli-user) — round 15 F2", () => {
    // Bundled channels emit channel-prefixed user senders (cli-user,
    // web-user, etc.). The selector previously missed them and silently
    // disabled tool filtering for default CLI sessions.
    const cli: readonly InboundMessage[] = [
      asMsg("cli-user", [{ kind: "text", text: "search the docs" }]),
      asMsg("assistant", [{ kind: "text", text: "ok" }]),
    ];
    expect(extractLastUserText(cli)).toBe("search the docs");

    const web: readonly InboundMessage[] = [
      asMsg("web-user", [{ kind: "text", text: "open issue 42" }]),
    ];
    expect(extractLastUserText(web)).toBe("open issue 42");

    const multiSession: readonly InboundMessage[] = [
      asMsg("cli-user-3", [{ kind: "text", text: "third user input" }]),
    ];
    expect(extractLastUserText(multiSession)).toBe("third user input");
  });
});
