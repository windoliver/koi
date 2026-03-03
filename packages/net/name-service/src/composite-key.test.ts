import { describe, expect, test } from "bun:test";
import { compositeKey, parseCompositeKey } from "./composite-key.js";

describe("compositeKey", () => {
  test("creates agent-scoped key", () => {
    expect(compositeKey("agent", "reviewer")).toBe("agent:reviewer");
  });

  test("creates zone-scoped key", () => {
    expect(compositeKey("zone", "code-reviewer")).toBe("zone:code-reviewer");
  });

  test("creates global-scoped key", () => {
    expect(compositeKey("global", "my-agent")).toBe("global:my-agent");
  });
});

describe("parseCompositeKey", () => {
  test("parses agent-scoped key", () => {
    expect(parseCompositeKey("agent:reviewer")).toEqual({
      scope: "agent",
      name: "reviewer",
    });
  });

  test("parses zone-scoped key", () => {
    expect(parseCompositeKey("zone:code-reviewer")).toEqual({
      scope: "zone",
      name: "code-reviewer",
    });
  });

  test("parses global-scoped key", () => {
    expect(parseCompositeKey("global:my-agent")).toEqual({
      scope: "global",
      name: "my-agent",
    });
  });

  test("round-trips correctly", () => {
    const key = compositeKey("zone", "test-agent");
    const parsed = parseCompositeKey(key);
    expect(parsed.scope).toBe("zone");
    expect(parsed.name).toBe("test-agent");
  });
});
