import { describe, expect, test } from "bun:test";

import { matchRoute } from "./router.js";

describe("matchRoute", () => {
  test("matches exact static path", () => {
    expect(matchRoute("/agents", "/agents")).toEqual({ params: {} });
  });

  test("returns undefined for length mismatch", () => {
    expect(matchRoute("/agents", "/agents/abc")).toBeUndefined();
    expect(matchRoute("/agents/:id", "/agents")).toBeUndefined();
  });

  test("captures single param", () => {
    expect(matchRoute("/agents/:id", "/agents/abc")).toEqual({
      params: { id: "abc" },
    });
  });

  test("captures multiple params", () => {
    expect(matchRoute("/agents/:id/sessions/:sid", "/agents/a/sessions/s1")).toEqual({
      params: { id: "a", sid: "s1" },
    });
  });

  test("decodes URL-encoded segments", () => {
    expect(matchRoute("/traces/:id", "/traces/turn%20one")).toEqual({
      params: { id: "turn one" },
    });
  });

  test("rejects empty param value", () => {
    expect(matchRoute("/agents/:id", "/agents/")).toBeUndefined();
  });

  test("returns undefined when literal segment differs", () => {
    expect(matchRoute("/agents/:id", "/users/abc")).toBeUndefined();
  });

  test("matches trailing slash invariant", () => {
    expect(matchRoute("/agents", "/agents/")).toEqual({ params: {} });
  });

  test("matches sub-path", () => {
    expect(matchRoute("/agents/:id/terminate", "/agents/abc/terminate")).toEqual({
      params: { id: "abc" },
    });
  });

  test("returns undefined for malformed percent-encoded segments", () => {
    // decodeURIComponent throws URIError on these — must not propagate.
    expect(matchRoute("/traces/:id", "/traces/%E0%A4%A")).toBeUndefined();
    expect(matchRoute("/agents/:id", "/agents/%")).toBeUndefined();
  });
});
