import { describe, expect, test } from "bun:test";
import { applyCors, isOriginAllowed } from "./cors.js";
import type { CorsConfig } from "./types.js";

const config: CorsConfig = {
  allowedOrigins: ["https://app.example.com"],
  allowedMethods: ["POST", "GET"],
  allowedHeaders: ["Content-Type", "X-Slack-Signature"],
  maxAgeSeconds: 60,
};

describe("isOriginAllowed", () => {
  test("exact match", () => {
    expect(isOriginAllowed("https://app.example.com", config)).toBe(true);
  });
  test("non-allowed", () => {
    expect(isOriginAllowed("https://evil.com", config)).toBe(false);
  });
  test("empty allowlist denies all", () => {
    expect(isOriginAllowed("https://app.example.com", { ...config, allowedOrigins: [] })).toBe(
      false,
    );
  });
});

describe("applyCors preflight", () => {
  test("allowed origin -> 204 with headers", () => {
    const req = new Request("http://x/", {
      method: "OPTIONS",
      headers: { Origin: "https://app.example.com", "Access-Control-Request-Method": "POST" },
    });
    const res = applyCors(req, config);
    expect(res?.status).toBe(204);
    expect(res?.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example.com");
  });

  test("disallowed origin -> 403 without ACAO", () => {
    const req = new Request("http://x/", {
      method: "OPTIONS",
      headers: { Origin: "https://evil.com", "Access-Control-Request-Method": "POST" },
    });
    const res = applyCors(req, config);
    expect(res?.status).toBe(403);
    expect(res?.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  test("non-OPTIONS returns null (continue pipeline)", () => {
    const req = new Request("http://x/", { method: "POST" });
    expect(applyCors(req, config)).toBeNull();
  });
});
