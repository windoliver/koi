import { describe, expect, it } from "bun:test";
import { loadHooks, loadHooksWithDiagnostics } from "./loader.js";

describe("loadHooks", () => {
  it("returns typed configs for valid input", () => {
    const result = loadHooks([
      { kind: "command", name: "a", cmd: ["echo", "hi"] },
      { kind: "http", name: "b", url: "https://example.com" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
      expect(result.value[0]?.kind).toBe("command");
      expect(result.value[1]?.kind).toBe("http");
    }
  });

  it("returns empty array for empty input", () => {
    const result = loadHooks([]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(0);
    }
  });

  it("filters out disabled hooks", () => {
    const result = loadHooks([
      { kind: "command", name: "active", cmd: ["echo"], enabled: true },
      { kind: "command", name: "disabled", cmd: ["echo"], enabled: false },
      { kind: "http", name: "also-active", url: "https://example.com" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
      expect(result.value[0]?.name).toBe("active");
      expect(result.value[1]?.name).toBe("also-active");
    }
  });

  it("returns error for invalid input", () => {
    const result = loadHooks([{ kind: "command", name: "", cmd: [] }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  it("returns error for unsupported hook type", () => {
    const result = loadHooks([{ kind: "prompt", name: "test", prompt: "hello" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  it("returns error for non-array input", () => {
    const result = loadHooks({ kind: "command", name: "a", cmd: ["echo"] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  it("returns empty array for undefined input (optional manifest field)", () => {
    const result = loadHooks(undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(0);
    }
  });

  it("returns empty array for null input", () => {
    const result = loadHooks(null);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(0);
    }
  });

  it("rejects duplicate hook names among active hooks", () => {
    const result = loadHooks([
      { kind: "command", name: "dupe", cmd: ["echo", "a"] },
      { kind: "command", name: "dupe", cmd: ["echo", "b"] },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("duplicate hook name");
      expect(result.error.message).toContain("dupe");
    }
  });

  it("allows duplicate names if one is disabled", () => {
    const result = loadHooks([
      { kind: "command", name: "dupe", cmd: ["echo", "a"] },
      { kind: "command", name: "dupe", cmd: ["echo", "b"], enabled: false },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
    }
  });

  it("allows different hook names", () => {
    const result = loadHooks([
      { kind: "command", name: "hook-a", cmd: ["echo", "a"] },
      { kind: "command", name: "hook-b", cmd: ["echo", "b"] },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
    }
  });

  it("preserves all fields on valid command hook", () => {
    const result = loadHooks([
      {
        kind: "command",
        name: "full",
        cmd: ["./script.sh", "--verbose"],
        env: { FOO: "bar" },
        filter: { events: ["session.started"], tools: ["exec"] },
        timeoutMs: 5000,
        serial: true,
      },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      const hook = result.value[0];
      if (hook === undefined) throw new Error("expected hook");
      expect(hook.kind).toBe("command");
      if (hook.kind === "command") {
        expect(hook.cmd).toEqual(["./script.sh", "--verbose"]);
        expect(hook.env).toEqual({ FOO: "bar" });
        expect(hook.filter?.events).toEqual(["session.started"]);
        expect(hook.timeoutMs).toBe(5000);
        expect(hook.serial).toBe(true);
      }
    }
  });

  it("preserves all fields on valid http hook", () => {
    const result = loadHooks([
      {
        kind: "http",
        name: "full",
        url: "https://api.example.com/hooks",
        method: "PUT",
        headers: { Authorization: "Bearer token" },
        secret: "my-secret",
        filter: { channels: ["telegram"] },
        timeoutMs: 10000,
      },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      const hook = result.value[0];
      if (hook === undefined) throw new Error("expected hook");
      expect(hook.kind).toBe("http");
      if (hook.kind === "http") {
        expect(hook.url).toBe("https://api.example.com/hooks");
        expect(hook.method).toBe("PUT");
        expect(hook.headers).toEqual({ Authorization: "Bearer token" });
        expect(hook.secret).toBe("my-secret");
      }
    }
  });
});

describe("loadHooksWithDiagnostics", () => {
  it("warns on unknown event kinds without rejecting", () => {
    const result = loadHooksWithDiagnostics([
      {
        kind: "command",
        name: "future-hook",
        cmd: ["echo"],
        filter: { events: ["session.started", "future.event"] },
      },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.hooks).toHaveLength(1);
      expect(result.value.warnings).toHaveLength(1);
      expect(result.value.warnings[0]).toContain("future.event");
      expect(result.value.warnings[0]).toContain("not in the built-in event set");
    }
  });

  it("returns no warnings for known event kinds", () => {
    const result = loadHooksWithDiagnostics([
      {
        kind: "command",
        name: "known-hook",
        cmd: ["echo"],
        filter: { events: ["session.started", "tool.succeeded"] },
      },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.warnings).toHaveLength(0);
    }
  });

  it("warns on typos in event kinds", () => {
    const result = loadHooksWithDiagnostics([
      {
        kind: "command",
        name: "typo-hook",
        cmd: ["echo"],
        filter: { events: ["sesion.started"] },
      },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.hooks).toHaveLength(1);
      expect(result.value.warnings).toHaveLength(1);
      expect(result.value.warnings[0]).toContain("sesion.started");
    }
  });

  it("returns hooks and empty warnings for valid input", () => {
    const result = loadHooksWithDiagnostics([{ kind: "command", name: "a", cmd: ["echo"] }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.hooks).toHaveLength(1);
      expect(result.value.warnings).toHaveLength(0);
    }
  });
});
