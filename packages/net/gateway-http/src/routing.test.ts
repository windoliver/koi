import { describe, expect, test } from "bun:test";
import { matchRoute } from "./routing.js";

describe("matchRoute", () => {
  test("POST /webhooks/slack/T123", () => {
    expect(matchRoute("POST", "/webhooks/slack/T123")).toEqual({
      kind: "webhook",
      channel: "slack",
      account: "T123",
    });
  });

  test("POST /webhooks/slack (no account)", () => {
    expect(matchRoute("POST", "/webhooks/slack")).toEqual({
      kind: "webhook",
      channel: "slack",
      account: undefined,
    });
  });

  test("GET /healthz", () => {
    expect(matchRoute("GET", "/healthz")).toEqual({ kind: "health" });
  });

  test("GET /ws is not advertised (deferred)", () => {
    expect(matchRoute("GET", "/ws")).toEqual({ kind: "not-found" });
  });

  test("OPTIONS /webhooks/x -- CORS preflight", () => {
    expect(matchRoute("OPTIONS", "/webhooks/slack")).toEqual({ kind: "preflight" });
  });

  test("unknown path -> not-found", () => {
    expect(matchRoute("GET", "/random")).toEqual({ kind: "not-found" });
  });

  test("wrong method on /healthz", () => {
    expect(matchRoute("POST", "/healthz")).toEqual({ kind: "not-found" });
  });
});
