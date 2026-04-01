import { describe, expect, test } from "bun:test";
import { createBearerAuthProvider } from "./auth.js";

describe("createBearerAuthProvider", () => {
  test("returns the static token", () => {
    const auth = createBearerAuthProvider("my-token-123");
    expect(auth.token()).toBe("my-token-123");
  });

  test("returns same token on repeated calls", () => {
    const auth = createBearerAuthProvider("stable");
    expect(auth.token()).toBe("stable");
    expect(auth.token()).toBe("stable");
  });

  test("does not define onUnauthorized", () => {
    const auth = createBearerAuthProvider("tok");
    expect(auth.onUnauthorized).toBeUndefined();
  });

  test("handles empty string token", () => {
    const auth = createBearerAuthProvider("");
    expect(auth.token()).toBe("");
  });
});
