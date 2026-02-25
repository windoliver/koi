import { describe, expect, test } from "bun:test";
import { walkJsonStrings } from "./sanitize-json.js";
import type { SanitizeRule } from "./types.js";

const STRIP_RULE: SanitizeRule = {
  name: "test-strip",
  pattern: /badword/i,
  action: { kind: "strip", replacement: "[redacted]" },
};

const BLOCK_RULE: SanitizeRule = {
  name: "test-block",
  pattern: /evil/i,
  action: { kind: "block", reason: "blocked" },
};

describe("walkJsonStrings", () => {
  test("sanitizes top-level string", () => {
    const result = walkJsonStrings("hello badword", [STRIP_RULE], "tool-input");
    expect(result.value).toBe("hello [redacted]");
    expect(result.events).toHaveLength(1);
  });

  test("passes non-string primitives through", () => {
    expect(walkJsonStrings(42, [STRIP_RULE], "tool-input").value).toBe(42);
    expect(walkJsonStrings(true, [STRIP_RULE], "tool-input").value).toBe(true);
    expect(walkJsonStrings(null, [STRIP_RULE], "tool-input").value).toBeNull();
    expect(walkJsonStrings(undefined, [STRIP_RULE], "tool-input").value).toBeUndefined();
  });

  test("sanitizes nested object strings", () => {
    const input = { a: "hello badword", b: { c: "deep badword" } };
    const result = walkJsonStrings(input, [STRIP_RULE], "tool-input");
    const output = result.value as Record<string, unknown>;
    expect(output.a).toBe("hello [redacted]");
    expect((output.b as Record<string, string>).c).toBe("deep [redacted]");
    expect(result.events).toHaveLength(2);
  });

  test("sanitizes array string elements", () => {
    const input = ["hello badword", 42, "another badword"];
    const result = walkJsonStrings(input, [STRIP_RULE], "tool-input");
    const output = result.value as unknown[];
    expect(output[0]).toBe("hello [redacted]");
    expect(output[1]).toBe(42);
    expect(output[2]).toBe("another [redacted]");
  });

  test("handles mixed nested arrays and objects", () => {
    const input = { data: [{ name: "badword" }, { name: "safe" }] };
    const result = walkJsonStrings(input, [STRIP_RULE], "tool-input");
    const data = (result.value as Record<string, unknown>).data as Array<Record<string, string>>;
    expect(data[0]?.name).toBe("[redacted]");
    expect(data[1]?.name).toBe("safe");
    expect(result.events).toHaveLength(1);
  });

  test("enforces depth limit", () => {
    // Build deeply nested structure
    // let justified: building nested object iteratively
    let obj: unknown = "badword at the bottom";
    for (let i = 0; i < 15; i++) {
      obj = { nested: obj };
    }

    const result = walkJsonStrings(obj, [STRIP_RULE], "tool-input", undefined, 5);
    // The string at depth > 5 should NOT be sanitized
    // Walk down to find the leaf
    // let justified: traversing nested structure to verify depth limit
    let current: unknown = result.value;
    for (let i = 0; i < 15; i++) {
      current = (current as Record<string, unknown>).nested;
    }
    // The deeply nested string should be unchanged
    expect(current).toBe("badword at the bottom");
  });

  test("sanitizes within depth limit", () => {
    const input = { a: { b: { c: "badword" } } };
    const result = walkJsonStrings(input, [STRIP_RULE], "tool-input", undefined, 10);
    expect(
      ((result.value as Record<string, unknown>).a as Record<string, unknown>).b as Record<
        string,
        unknown
      >,
    ).toEqual({ c: "[redacted]" });
  });

  test("preserves immutability — original not mutated", () => {
    const input = { a: "badword", b: { c: "nested badword" } };
    const frozen = JSON.parse(JSON.stringify(input)) as typeof input;
    walkJsonStrings(input, [STRIP_RULE], "tool-input");
    expect(input).toEqual(frozen);
  });

  test("returns original reference when no changes", () => {
    const input = { a: "safe", b: [1, 2, 3] };
    const result = walkJsonStrings(input, [STRIP_RULE], "tool-input");
    expect(result.value).toBe(input);
    expect(result.events).toHaveLength(0);
  });

  test("reports blocked from nested string", () => {
    const input = { deep: { text: "evil content" } };
    const result = walkJsonStrings(input, [BLOCK_RULE], "tool-output");
    expect(result.blocked).toBe(true);
  });

  test("fires onSanitization callback for each match", () => {
    const events: unknown[] = [];
    walkJsonStrings({ a: "badword", b: "badword" }, [STRIP_RULE], "tool-input", (e) =>
      events.push(e),
    );
    expect(events).toHaveLength(2);
  });

  test("handles empty objects and arrays", () => {
    expect(walkJsonStrings({}, [STRIP_RULE], "tool-input").value).toEqual({});
    expect(walkJsonStrings([], [STRIP_RULE], "tool-input").value).toEqual([]);
  });
});
