import { describe, expect, test } from "bun:test";
import { extractReadContent } from "./extract-read-content.js";

describe("extractReadContent", () => {
  test("accepts bare string", () => {
    const r = extractReadContent("policy data");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("policy data");
  });

  test("accepts { content: string }", () => {
    const r = extractReadContent({ content: "policy data" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("policy data");
  });

  test("rejects null", () => {
    const r = extractReadContent(null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("VALIDATION");
  });

  test("rejects object without content", () => {
    const r = extractReadContent({ foo: "bar" });
    expect(r.ok).toBe(false);
  });

  test("rejects object with non-string content", () => {
    const r = extractReadContent({ content: 42 });
    expect(r.ok).toBe(false);
  });

  test("rejects number", () => {
    const r = extractReadContent(42);
    expect(r.ok).toBe(false);
  });
});
