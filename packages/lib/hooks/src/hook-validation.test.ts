import { describe, expect, it } from "bun:test";
import type { AgentHookConfig, CommandHookConfig, HttpHookConfig } from "@koi/core";
import { resolveFailMode, resolveTimeout, validateHookUrl } from "./hook-validation.js";

// ---------------------------------------------------------------------------
// validateHookUrl
// ---------------------------------------------------------------------------

describe("validateHookUrl", () => {
  it("accepts HTTPS URLs", () => {
    expect(validateHookUrl("https://api.example.com/hook")).toBeUndefined();
  });

  it("accepts localhost HTTP in test mode", () => {
    // bun:test sets NODE_ENV=test
    expect(validateHookUrl("http://localhost:3000/hook")).toBeUndefined();
    expect(validateHookUrl("http://127.0.0.1:3000/hook")).toBeUndefined();
    expect(validateHookUrl("http://[::1]:3000/hook")).toBeUndefined();
  });

  it("rejects non-loopback HTTP in test mode", () => {
    expect(validateHookUrl("http://evil.example.com/hook")).toBeDefined();
  });

  it("rejects invalid URLs", () => {
    expect(validateHookUrl("not-a-url")).toBe("invalid URL");
  });

  it("rejects unsupported protocols", () => {
    const error = validateHookUrl("ftp://files.example.com/hook");
    expect(error).toContain("unsupported protocol");
  });
});

// ---------------------------------------------------------------------------
// resolveTimeout
// ---------------------------------------------------------------------------

describe("resolveTimeout", () => {
  it("returns explicit timeoutMs when set", () => {
    const hook: CommandHookConfig = { kind: "command", name: "t", cmd: ["echo"], timeoutMs: 5000 };
    expect(resolveTimeout(hook)).toBe(5000);
  });

  it("defaults to 30_000 for command hooks", () => {
    const hook: CommandHookConfig = { kind: "command", name: "t", cmd: ["echo"] };
    expect(resolveTimeout(hook)).toBe(30_000);
  });

  it("defaults to 30_000 for http hooks", () => {
    const hook: HttpHookConfig = { kind: "http", name: "t", url: "https://example.com" };
    expect(resolveTimeout(hook)).toBe(30_000);
  });

  it("defaults to 60_000 for agent hooks", () => {
    const hook: AgentHookConfig = { kind: "agent", name: "t", prompt: "check" };
    expect(resolveTimeout(hook)).toBe(60_000);
  });

  it("respects explicit timeoutMs on agent hooks", () => {
    const hook: AgentHookConfig = { kind: "agent", name: "t", prompt: "check", timeoutMs: 10_000 };
    expect(resolveTimeout(hook)).toBe(10_000);
  });
});

// ---------------------------------------------------------------------------
// resolveFailMode
// ---------------------------------------------------------------------------

describe("resolveFailMode", () => {
  it("defaults to true (fail-closed) for command hooks", () => {
    const hook: CommandHookConfig = { kind: "command", name: "t", cmd: ["echo"] };
    expect(resolveFailMode(hook)).toBe(true);
  });

  it("defaults to true (fail-closed) for http hooks", () => {
    const hook: HttpHookConfig = { kind: "http", name: "t", url: "https://example.com" };
    expect(resolveFailMode(hook)).toBe(true);
  });

  it("defaults to true (fail-closed) for agent hooks", () => {
    const hook: AgentHookConfig = { kind: "agent", name: "t", prompt: "verify" };
    expect(resolveFailMode(hook)).toBe(true);
  });

  it("respects explicit failClosed=true on command hooks", () => {
    const hook: CommandHookConfig = {
      kind: "command",
      name: "t",
      cmd: ["echo"],
      failClosed: true,
    };
    expect(resolveFailMode(hook)).toBe(true);
  });

  it("respects explicit failClosed=false on agent hooks", () => {
    const hook: AgentHookConfig = {
      kind: "agent",
      name: "t",
      prompt: "verify",
      failClosed: false,
    };
    expect(resolveFailMode(hook)).toBe(false);
  });
});
