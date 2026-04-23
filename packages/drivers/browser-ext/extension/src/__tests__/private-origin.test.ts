import { beforeEach, describe, expect, test } from "bun:test";
import { isOriginAllowedByPolicy, isPrivateOrigin } from "../private-origin.js";
import { createExtensionStorage } from "../storage.js";
import { installChromeStub } from "./chrome-stub.js";

describe("private-origin gate", () => {
  beforeEach(() => {
    installChromeStub();
  });

  test("detects blocked origins", () => {
    expect(isPrivateOrigin("http://localhost:3000")).toBe(true);
    expect(isPrivateOrigin("http://192.168.1.10")).toBe(true);
    expect(isPrivateOrigin("http://service.internal")).toBe(true);
    expect(isPrivateOrigin("https://example.com")).toBe(false);
  });

  test("allows private origins only when explicitly allowlisted", async () => {
    const storage = createExtensionStorage();
    expect(await isOriginAllowedByPolicy(storage, "http://localhost:3000")).toBe(false);
    await storage.setPrivateOriginAllowlist(["http://localhost:3000"]);
    expect(await isOriginAllowedByPolicy(storage, "http://localhost:3000")).toBe(true);
  });
});
