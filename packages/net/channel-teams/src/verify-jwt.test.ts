import { describe, expect, test } from "bun:test";
import { createBotFrameworkAuthenticator } from "./verify-jwt.js";

const TEST_APP_ID = "test-app-id-12345";

describe("createBotFrameworkAuthenticator", () => {
  const authenticator = createBotFrameworkAuthenticator(TEST_APP_ID);

  describe("missing or malformed Authorization header", () => {
    test("returns missing_auth_header when no Authorization header", async () => {
      const req = new Request("http://localhost:3978/api/messages", {
        method: "POST",
      });
      const result = await authenticator.verify(req);
      expect(result).toEqual({ ok: false, reason: "missing_auth_header" });
    });

    test("returns missing_auth_header when Authorization header is empty", async () => {
      const req = new Request("http://localhost:3978/api/messages", {
        method: "POST",
        headers: { Authorization: "" },
      });
      const result = await authenticator.verify(req);
      expect(result).toEqual({ ok: false, reason: "missing_auth_header" });
    });

    test("returns missing_auth_header when scheme is not Bearer", async () => {
      const req = new Request("http://localhost:3978/api/messages", {
        method: "POST",
        headers: { Authorization: "Basic abc123" },
      });
      const result = await authenticator.verify(req);
      expect(result).toEqual({ ok: false, reason: "missing_auth_header" });
    });

    test("returns missing_auth_header when Bearer token is missing", async () => {
      const req = new Request("http://localhost:3978/api/messages", {
        method: "POST",
        headers: { Authorization: "Bearer " },
      });
      const result = await authenticator.verify(req);
      expect(result).toEqual({ ok: false, reason: "missing_auth_header" });
    });

    test("returns missing_auth_header when only Bearer keyword", async () => {
      const req = new Request("http://localhost:3978/api/messages", {
        method: "POST",
        headers: { Authorization: "Bearer" },
      });
      const result = await authenticator.verify(req);
      expect(result).toEqual({ ok: false, reason: "missing_auth_header" });
    });
  });

  describe("invalid tokens", () => {
    test("returns invalid_token for a garbage token", async () => {
      const req = new Request("http://localhost:3978/api/messages", {
        method: "POST",
        headers: { Authorization: "Bearer not-a-real-jwt" },
      });
      const result = await authenticator.verify(req);
      expect(result).toEqual({ ok: false, reason: "invalid_token" });
    });

    test("returns invalid_token for a well-formed but unsigned JWT", async () => {
      // Create a JWT with no signature (alg: none)
      const header = btoa(JSON.stringify({ alg: "none", typ: "JWT" }));
      const payload = btoa(
        JSON.stringify({ aud: TEST_APP_ID, iss: "https://sts.windows.net/fake/" }),
      );
      const fakeJwt = `${header}.${payload}.`;

      const req = new Request("http://localhost:3978/api/messages", {
        method: "POST",
        headers: { Authorization: `Bearer ${fakeJwt}` },
      });
      const result = await authenticator.verify(req);
      expect(result).toEqual({ ok: false, reason: "invalid_token" });
    });
  });
});
