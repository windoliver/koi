import { describe, expect, test } from "bun:test";
import {
  CREDENTIALS,
  channelToken,
  EVENTS,
  GOVERNANCE,
  MEMORY,
  skillToken,
  token,
  toolToken,
} from "../index.js";

/** Widen a branded token to plain string for runtime assertions. */
function str(value: string): string {
  return value;
}

describe("token()", () => {
  test("returns the name string", () => {
    expect(str(token("foo"))).toBe("foo");
  });

  test("returns typed SubsystemToken", () => {
    const t = token<{ readonly x: number }>("bar");
    expect(typeof t).toBe("string");
  });

  test("different names produce different tokens", () => {
    expect(str(token("a"))).not.toBe(str(token("b")));
  });

  test("empty string produces empty token", () => {
    expect(str(token(""))).toBe("");
  });
});

describe("toolToken()", () => {
  test("prefixes with tool:", () => {
    expect(str(toolToken("calc"))).toBe("tool:calc");
  });

  test("contains namespace separator", () => {
    expect(str(toolToken("search"))).toContain(":");
  });

  test("empty string produces 'tool:'", () => {
    expect(str(toolToken(""))).toBe("tool:");
  });

  test("colon in name produces double colon", () => {
    expect(str(toolToken("foo:bar"))).toBe("tool:foo:bar");
  });
});

describe("channelToken()", () => {
  test("prefixes with channel:", () => {
    expect(str(channelToken("telegram"))).toBe("channel:telegram");
  });

  test("contains namespace separator", () => {
    expect(str(channelToken("slack"))).toContain(":");
  });

  test("unicode name is preserved", () => {
    expect(str(channelToken("\u{1F527}"))).toBe("channel:\u{1F527}");
  });
});

describe("skillToken()", () => {
  test("prefixes with skill:", () => {
    expect(str(skillToken("research"))).toBe("skill:research");
  });

  test("contains namespace separator", () => {
    expect(str(skillToken("summarize"))).toContain(":");
  });
});

describe("well-known singleton tokens", () => {
  test("MEMORY equals 'memory'", () => {
    expect(str(MEMORY)).toBe("memory");
  });

  test("GOVERNANCE equals 'governance'", () => {
    expect(str(GOVERNANCE)).toBe("governance");
  });

  test("CREDENTIALS equals 'credentials'", () => {
    expect(str(CREDENTIALS)).toBe("credentials");
  });

  test("EVENTS equals 'events'", () => {
    expect(str(EVENTS)).toBe("events");
  });

  test("singleton tokens do not contain ':'", () => {
    expect(str(MEMORY)).not.toContain(":");
    expect(str(GOVERNANCE)).not.toContain(":");
    expect(str(CREDENTIALS)).not.toContain(":");
    expect(str(EVENTS)).not.toContain(":");
  });
});
