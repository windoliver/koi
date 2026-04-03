import { describe, expect, test } from "bun:test";
import type { HookConfig, HookEventKind } from "./hook.js";
import { HOOK_EVENT_KINDS } from "./hook.js";

describe("HOOK_EVENT_KINDS", () => {
  test("contains expected event kinds", () => {
    expect(HOOK_EVENT_KINDS).toContain("session.started");
    expect(HOOK_EVENT_KINDS).toContain("session.ended");
    expect(HOOK_EVENT_KINDS).toContain("tool.before");
    expect(HOOK_EVENT_KINDS).toContain("tool.succeeded");
    expect(HOOK_EVENT_KINDS).toContain("tool.failed");
    expect(HOOK_EVENT_KINDS).toHaveLength(15);
  });

  test("HookEventKind type matches const array members", () => {
    // Compile-time check: assigning array members to the type succeeds
    const first = HOOK_EVENT_KINDS[0];
    if (first === undefined) {
      throw new Error("Expected HOOK_EVENT_KINDS to be non-empty");
    }
    const kind: HookEventKind = first;
    expect(typeof kind).toBe("string");
  });
});

describe("HookConfig discriminated union", () => {
  test("discriminates on kind for command config", () => {
    const config: HookConfig = {
      kind: "command",
      name: "lint-check",
      command: "bun run lint",
    };
    expect(config.kind).toBe("command");
    if (config.kind === "command") {
      expect(config.command).toBe("bun run lint");
    }
  });

  test("discriminates on kind for http config", () => {
    const config: HookConfig = {
      kind: "http",
      name: "webhook",
      url: "https://example.com/hook",
    };
    expect(config.kind).toBe("http");
    if (config.kind === "http") {
      expect(config.url).toBe("https://example.com/hook");
    }
  });

  test("discriminates on kind for prompt config", () => {
    const config: HookConfig = {
      kind: "prompt",
      name: "safety-check",
      prompt: "Is this safe?",
    };
    expect(config.kind).toBe("prompt");
    if (config.kind === "prompt") {
      expect(config.prompt).toBe("Is this safe?");
    }
  });

  test("discriminates on kind for agent config", () => {
    const config: HookConfig = {
      kind: "agent",
      name: "deep-review",
      prompt: "Review this action",
    };
    expect(config.kind).toBe("agent");
    if (config.kind === "agent") {
      expect(config.prompt).toBe("Review this action");
    }
  });

  test("switch exhaustiveness covers all kinds", () => {
    const configs: readonly HookConfig[] = [
      { kind: "command", name: "a", command: "echo" },
      { kind: "http", name: "b", url: "https://x.com" },
      { kind: "prompt", name: "c", prompt: "check" },
      { kind: "agent", name: "d", prompt: "review" },
    ];

    const kinds: string[] = [];
    for (const c of configs) {
      switch (c.kind) {
        case "command":
          kinds.push("command");
          break;
        case "http":
          kinds.push("http");
          break;
        case "prompt":
          kinds.push("prompt");
          break;
        case "agent":
          kinds.push("agent");
          break;
      }
    }
    expect(kinds).toEqual(["command", "http", "prompt", "agent"]);
  });
});
