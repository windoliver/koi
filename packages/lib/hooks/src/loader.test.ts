import { describe, expect, it } from "bun:test";
import { loadHooks, loadHooksWithDiagnostics, loadRegisteredHooksPerEntry } from "./loader.js";

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

  it("loads prompt hooks successfully", () => {
    const result = loadHooks([{ kind: "prompt", name: "safety-check", prompt: "Is this safe?" }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.kind).toBe("prompt");
      expect(result.value[0]?.name).toBe("safety-check");
    }
  });

  it("preserves all fields on valid prompt hook", () => {
    const result = loadHooks([
      {
        kind: "prompt",
        name: "full-prompt",
        prompt: "Verify this action",
        model: "sonnet",
        maxTokens: 128,
        timeoutMs: 5000,
        filter: { events: ["tool.before"], tools: ["Bash"] },
        serial: true,
        failClosed: false,
      },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      const hook = result.value[0];
      if (hook === undefined) throw new Error("expected hook");
      expect(hook.kind).toBe("prompt");
      if (hook.kind === "prompt") {
        expect(hook.prompt).toBe("Verify this action");
        expect(hook.model).toBe("sonnet");
        expect(hook.maxTokens).toBe(128);
        expect(hook.timeoutMs).toBe(5000);
        expect(hook.serial).toBe(true);
        expect(hook.failClosed).toBe(false);
      }
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

describe("loadRegisteredHooksPerEntry", () => {
  it("returns empty result for undefined / null", () => {
    for (const raw of [undefined, null]) {
      const result = loadRegisteredHooksPerEntry(raw, "user");
      expect(result.hooks).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    }
  });

  it("reports a structural error when root is not an array", () => {
    const result = loadRegisteredHooksPerEntry(
      { kind: "command", name: "a", cmd: ["echo"] },
      "user",
    );
    expect(result.hooks).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.index).toBe(-1);
    expect(result.errors[0]?.message).toContain("array");
  });

  it("loads valid peers when one entry fails validation", () => {
    // The regression: a single bad hook (empty cmd) used to drop the whole file.
    const result = loadRegisteredHooksPerEntry(
      [
        { kind: "command", name: "good-1", cmd: ["echo", "a"] },
        { kind: "command", name: "bad", cmd: [] },
        { kind: "http", name: "good-2", url: "https://example.com" },
      ],
      "user",
    );
    expect(result.hooks.map((rh) => rh.hook.name)).toEqual(["good-1", "good-2"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.index).toBe(1);
    expect(result.errors[0]?.name).toBe("bad");
    expect(result.errors[0]?.message).toContain("Hook[1]");
  });

  it("tags loaded hooks with the given tier", () => {
    const result = loadRegisteredHooksPerEntry(
      [{ kind: "command", name: "a", cmd: ["echo"] }],
      "managed",
    );
    expect(result.hooks).toHaveLength(1);
    expect(result.hooks[0]?.tier).toBe("managed");
    expect(result.hooks[0]?.id).toBe("managed:a");
  });

  it("filters disabled entries without reporting them as errors", () => {
    const result = loadRegisteredHooksPerEntry(
      [
        { kind: "command", name: "on", cmd: ["echo"] },
        { kind: "command", name: "off", cmd: ["echo"], enabled: false },
      ],
      "user",
    );
    expect(result.hooks.map((rh) => rh.hook.name)).toEqual(["on"]);
    expect(result.errors).toHaveLength(0);
  });

  it("keeps the first occurrence on duplicate names and reports the dupe", () => {
    const result = loadRegisteredHooksPerEntry(
      [
        { kind: "command", name: "dupe", cmd: ["echo", "first"] },
        { kind: "command", name: "dupe", cmd: ["echo", "second"] },
      ],
      "user",
    );
    expect(result.hooks).toHaveLength(1);
    expect(result.hooks[0]?.hook.kind).toBe("command");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.index).toBe(1);
    expect(result.errors[0]?.name).toBe("dupe");
    expect(result.errors[0]?.message).toContain("Duplicate");
  });

  it("emits warnings for unknown event kinds on accepted entries", () => {
    const result = loadRegisteredHooksPerEntry(
      [
        {
          kind: "command",
          name: "future",
          cmd: ["echo"],
          filter: { events: ["future.event"] },
        },
      ],
      "user",
    );
    expect(result.hooks).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("future.event");
  });

  it("carries the declared name even when the entry fails type validation", () => {
    const result = loadRegisteredHooksPerEntry(
      [{ kind: "command", name: "needs-cmd", cmd: [] }],
      "user",
    );
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.name).toBe("needs-cmd");
  });

  it("omits name when the entry has no parseable name field", () => {
    const result = loadRegisteredHooksPerEntry([{ kind: "nope" }], "user");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.name).toBeUndefined();
  });

  it("sniffs failClosed:true from invalid entries so callers can honor it", () => {
    const result = loadRegisteredHooksPerEntry(
      [{ kind: "command", name: "deny", cmd: [], failClosed: true }],
      "user",
    );
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.failClosed).toBe(true);
    expect(result.errors[0]?.name).toBe("deny");
  });

  it("leaves failClosed undefined when absent or non-boolean", () => {
    const result = loadRegisteredHooksPerEntry(
      [
        { kind: "command", name: "no-flag", cmd: [] },
        { kind: "command", name: "bad-type", cmd: [], failClosed: "yes" },
      ],
      "user",
    );
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]?.failClosed).toBeUndefined();
    expect(result.errors[1]?.failClosed).toBeUndefined();
  });
});
