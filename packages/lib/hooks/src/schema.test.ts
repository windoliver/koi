import { describe, expect, it } from "bun:test";
import {
  agentHookSchema,
  commandHookSchema,
  hookConfigSchema,
  hookFilterSchema,
  httpHookSchema,
} from "./schema.js";

describe("hookFilterSchema", () => {
  it("accepts empty filter", () => {
    const result = hookFilterSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts filter with events", () => {
    const result = hookFilterSchema.safeParse({ events: ["session.started"] });
    expect(result.success).toBe(true);
  });

  it("accepts filter with all fields", () => {
    const result = hookFilterSchema.safeParse({
      events: ["session.started", "tool.succeeded"],
      tools: ["exec"],
      channels: ["telegram"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty string in events array", () => {
    const result = hookFilterSchema.safeParse({ events: [""] });
    expect(result.success).toBe(false);
  });

  it("rejects empty string in tools array", () => {
    const result = hookFilterSchema.safeParse({ tools: [""] });
    expect(result.success).toBe(false);
  });

  it("rejects empty events array", () => {
    const result = hookFilterSchema.safeParse({ events: [] });
    expect(result.success).toBe(false);
  });

  it("rejects empty tools array", () => {
    const result = hookFilterSchema.safeParse({ tools: [] });
    expect(result.success).toBe(false);
  });

  it("rejects empty channels array", () => {
    const result = hookFilterSchema.safeParse({ channels: [] });
    expect(result.success).toBe(false);
  });

  it("accepts unknown event kinds for forward compatibility", () => {
    // Runtime validation accepts any non-empty string so that newer event
    // kinds added to HOOK_EVENT_KINDS don't brick older validators.
    // Compile-time safety is provided by the HookEventKind type instead.
    const result = hookFilterSchema.safeParse({ events: ["future.event"] });
    expect(result.success).toBe(true);
  });
});

describe("commandHookSchema", () => {
  const validCommand = {
    kind: "command",
    name: "on-start",
    cmd: ["./scripts/on-start.sh"],
  } as const;

  it("accepts minimal valid command hook", () => {
    const result = commandHookSchema.safeParse(validCommand);
    expect(result.success).toBe(true);
  });

  it("accepts command hook with all optional fields", () => {
    const result = commandHookSchema.safeParse({
      ...validCommand,
      env: { FOO: "bar" },
      filter: { events: ["session.started"] },
      enabled: true,
      timeoutMs: 5000,
      serial: true,
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty name", () => {
    const result = commandHookSchema.safeParse({ ...validCommand, name: "" });
    expect(result.success).toBe(false);
  });

  it("rejects empty cmd array", () => {
    const result = commandHookSchema.safeParse({ ...validCommand, cmd: [] });
    expect(result.success).toBe(false);
  });

  it("rejects cmd with empty string", () => {
    const result = commandHookSchema.safeParse({ ...validCommand, cmd: [""] });
    expect(result.success).toBe(false);
  });

  it("rejects negative timeoutMs", () => {
    const result = commandHookSchema.safeParse({ ...validCommand, timeoutMs: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects zero timeoutMs", () => {
    const result = commandHookSchema.safeParse({ ...validCommand, timeoutMs: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects fractional timeoutMs", () => {
    const result = commandHookSchema.safeParse({ ...validCommand, timeoutMs: 1.5 });
    expect(result.success).toBe(false);
  });

  it("rejects wrong kind", () => {
    const result = commandHookSchema.safeParse({ ...validCommand, kind: "http" });
    expect(result.success).toBe(false);
  });
});

describe("httpHookSchema", () => {
  const validHttp = {
    kind: "http",
    name: "notify-backend",
    url: "https://api.example.com/hooks",
  } as const;

  it("accepts minimal valid http hook", () => {
    const result = httpHookSchema.safeParse(validHttp);
    expect(result.success).toBe(true);
  });

  it("accepts http hook with all optional fields", () => {
    const result = httpHookSchema.safeParse({
      ...validHttp,
      method: "PUT",
      headers: { Authorization: "Bearer token" },
      secret: "my-secret",
      filter: { events: ["session.ended"] },
      enabled: false,
      timeoutMs: 10000,
      serial: false,
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid URL", () => {
    const result = httpHookSchema.safeParse({ ...validHttp, url: "not-a-url" });
    expect(result.success).toBe(false);
  });

  it("rejects non-HTTPS URL in production", () => {
    const result = httpHookSchema.safeParse({
      ...validHttp,
      url: "http://api.example.com/hooks",
    });
    expect(result.success).toBe(false);
  });

  it("allows HTTP URL for localhost in dev/test mode", () => {
    // bun:test sets NODE_ENV=test, so loopback is allowed
    for (const url of [
      "http://localhost:3000/hooks",
      "http://127.0.0.1:3000/hooks",
      "http://[::1]:3000/hooks",
    ]) {
      const result = httpHookSchema.safeParse({ ...validHttp, url });
      expect(result.success).toBe(true);
    }
  });

  it("rejects HTTP localhost in production mode", () => {
    const origNodeEnv = process.env.NODE_ENV;
    const origKoiDev = process.env.KOI_DEV;
    process.env.NODE_ENV = "production";
    delete process.env.KOI_DEV;

    const result = httpHookSchema.safeParse({
      ...validHttp,
      url: "http://localhost:3000/hooks",
    });
    expect(result.success).toBe(false);

    // Restore
    if (origNodeEnv !== undefined) {
      process.env.NODE_ENV = origNodeEnv;
    } else {
      delete process.env.NODE_ENV;
    }
    if (origKoiDev !== undefined) {
      process.env.KOI_DEV = origKoiDev;
    }
  });

  it("allows HTTPS URL", () => {
    const result = httpHookSchema.safeParse({
      ...validHttp,
      url: "https://api.example.com/hooks",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid method", () => {
    const result = httpHookSchema.safeParse({ ...validHttp, method: "GET" });
    expect(result.success).toBe(false);
  });

  it("rejects empty name", () => {
    const result = httpHookSchema.safeParse({ ...validHttp, name: "" });
    expect(result.success).toBe(false);
  });
});

describe("hookConfigSchema (discriminated union)", () => {
  it("accepts command hook", () => {
    const result = hookConfigSchema.safeParse({
      kind: "command",
      name: "test",
      cmd: ["echo", "hi"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe("command");
    }
  });

  it("accepts http hook", () => {
    const result = hookConfigSchema.safeParse({
      kind: "http",
      name: "test",
      url: "https://example.com",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe("http");
    }
  });

  it("rejects unsupported hook kind", () => {
    const result = hookConfigSchema.safeParse({
      kind: "prompt",
      name: "test",
      prompt: "hello",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing kind", () => {
    const result = hookConfigSchema.safeParse({
      name: "test",
      cmd: ["echo"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown kind clearly", () => {
    const result = hookConfigSchema.safeParse({
      kind: "websocket",
      name: "test",
    });
    expect(result.success).toBe(false);
  });

  it("accepts agent hook", () => {
    const result = hookConfigSchema.safeParse({
      kind: "agent",
      name: "verify-security",
      prompt: "Check the diff for security issues",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe("agent");
    }
  });
});

// ---------------------------------------------------------------------------
// Agent hook schema
// ---------------------------------------------------------------------------

describe("agentHookSchema", () => {
  const validAgent = {
    kind: "agent",
    name: "security-reviewer",
    prompt: "Review this change for security issues",
  } as const;

  it("accepts minimal valid agent hook", () => {
    const result = agentHookSchema.safeParse(validAgent);
    expect(result.success).toBe(true);
  });

  it("accepts agent hook with all optional fields", () => {
    const result = agentHookSchema.safeParse({
      ...validAgent,
      model: "haiku",
      systemPrompt: "You are a security auditor.",
      timeoutMs: 30000,
      maxTurns: 5,
      maxTokens: 2048,
      maxSessionTokens: 25000,
      toolDenylist: ["Bash", "Write"],
      filter: { events: ["tool.before"], tools: ["Edit"] },
      enabled: true,
      serial: true,
      failClosed: true,
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty prompt", () => {
    const result = agentHookSchema.safeParse({ ...validAgent, prompt: "" });
    expect(result.success).toBe(false);
  });

  it("rejects empty name", () => {
    const result = agentHookSchema.safeParse({ ...validAgent, name: "" });
    expect(result.success).toBe(false);
  });

  it("rejects negative maxTurns", () => {
    const result = agentHookSchema.safeParse({ ...validAgent, maxTurns: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects zero maxTurns", () => {
    const result = agentHookSchema.safeParse({ ...validAgent, maxTurns: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects fractional maxTurns", () => {
    const result = agentHookSchema.safeParse({ ...validAgent, maxTurns: 1.5 });
    expect(result.success).toBe(false);
  });

  it("rejects negative maxTokens", () => {
    const result = agentHookSchema.safeParse({ ...validAgent, maxTokens: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects negative maxSessionTokens", () => {
    const result = agentHookSchema.safeParse({ ...validAgent, maxSessionTokens: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects empty toolDenylist array", () => {
    const result = agentHookSchema.safeParse({ ...validAgent, toolDenylist: [] });
    expect(result.success).toBe(false);
  });

  it("rejects toolDenylist with empty strings", () => {
    const result = agentHookSchema.safeParse({ ...validAgent, toolDenylist: [""] });
    expect(result.success).toBe(false);
  });

  it("rejects wrong kind", () => {
    const result = agentHookSchema.safeParse({ ...validAgent, kind: "command" });
    expect(result.success).toBe(false);
  });

  it("rejects missing prompt", () => {
    const result = agentHookSchema.safeParse({ kind: "agent", name: "test" });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// failClosed on all hook types
// ---------------------------------------------------------------------------

describe("failClosed across hook types", () => {
  it("accepts failClosed on command hooks", () => {
    const result = commandHookSchema.safeParse({
      kind: "command",
      name: "test",
      cmd: ["echo"],
      failClosed: true,
    });
    expect(result.success).toBe(true);
  });

  it("accepts failClosed on http hooks", () => {
    const result = httpHookSchema.safeParse({
      kind: "http",
      name: "test",
      url: "https://example.com",
      failClosed: false,
    });
    expect(result.success).toBe(true);
  });

  it("accepts failClosed on agent hooks", () => {
    const result = agentHookSchema.safeParse({
      kind: "agent",
      name: "test",
      prompt: "verify",
      failClosed: true,
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid failClosed value (non-boolean)", () => {
    const result = commandHookSchema.safeParse({
      kind: "command",
      name: "test",
      cmd: ["echo"],
      failClosed: "maybe",
    });
    expect(result.success).toBe(false);
  });
});
