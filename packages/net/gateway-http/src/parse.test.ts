import { describe, expect, test } from "bun:test";
import { parseBody } from "./parse.js";

describe("parseBody", () => {
  test("valid JSON object -> ok", () => {
    const r = parseBody(`{"x":1}`, "application/json");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ x: 1 });
  });

  test("syntactically invalid -> INVALID_BODY", () => {
    const r = parseBody(`{`, "application/json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_BODY");
  });

  test("non-object JSON -> INVALID_BODY", () => {
    const r = parseBody(`42`, "application/json");
    expect(r.ok).toBe(false);
  });

  test("non-JSON content-type without channel parser -> INVALID_BODY", () => {
    const r = parseBody(`a=1&b=2`, "application/x-www-form-urlencoded");
    expect(r.ok).toBe(false);
  });

  test("channel parser overrides default", () => {
    const channelParser = (raw: string, _ct: string | null) => ({
      ok: true as const,
      value: { raw },
    });
    const r = parseBody(`anything`, "text/plain", channelParser);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ raw: "anything" });
  });
});
