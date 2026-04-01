import { describe, expect, test } from "bun:test";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { createMockDriver } from "../test-helpers.js";
import { compileNavigationSecurity } from "../url-security.js";
import { createBrowserNavigateTool } from "./navigate.js";

describe("browser_navigate", () => {
  test("navigates to a URL successfully", async () => {
    const driver = createMockDriver();
    const tool = createBrowserNavigateTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ url: "https://example.com" });
    expect(result).toMatchObject({ url: expect.any(String), title: expect.any(String) });
  });

  test("rejects missing url", async () => {
    const driver = createMockDriver();
    const tool = createBrowserNavigateTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({});
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects empty url", async () => {
    const driver = createMockDriver();
    const tool = createBrowserNavigateTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ url: "" });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects invalid waitUntil value", async () => {
    const driver = createMockDriver();
    const tool = createBrowserNavigateTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ url: "https://example.com", waitUntil: "ready" });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects timeout below minimum", async () => {
    const driver = createMockDriver();
    const tool = createBrowserNavigateTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ url: "https://example.com", timeout: 0 });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects timeout above maximum", async () => {
    const driver = createMockDriver();
    const tool = createBrowserNavigateTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ url: "https://example.com", timeout: 999999 });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("returns error on driver failure", async () => {
    const driver = createMockDriver({ failWith: "EXTERNAL" });
    const tool = createBrowserNavigateTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ url: "https://example.com" });
    expect(result).toMatchObject({ code: "EXTERNAL" });
  });
});

describe("browser_navigate — security config wiring", () => {
  test("blocks private IP when security enabled (PERMISSION)", async () => {
    const driver = createMockDriver();
    const security = compileNavigationSecurity();
    const tool = createBrowserNavigateTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY, security);
    const result = await tool.execute({ url: "https://192.168.1.1/admin" });
    expect(result).toMatchObject({ code: "PERMISSION" });
  });

  test("blocks disallowed protocol when custom allowedProtocols set", async () => {
    const driver = createMockDriver();
    const security = compileNavigationSecurity({ allowedProtocols: ["https:"] });
    const tool = createBrowserNavigateTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY, security);
    const result = await tool.execute({ url: "http://example.com" });
    expect(result).toMatchObject({ code: "PERMISSION" });
  });

  test("blocks domain outside allowlist", async () => {
    const driver = createMockDriver();
    const security = compileNavigationSecurity({ allowedDomains: ["allowed.com"] });
    const tool = createBrowserNavigateTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY, security);
    const result = await tool.execute({ url: "https://blocked.com/" });
    expect(result).toMatchObject({ code: "PERMISSION" });
  });

  test("allows URL matching domain allowlist", async () => {
    const driver = createMockDriver();
    const security = compileNavigationSecurity({ allowedDomains: ["example.com"] });
    const tool = createBrowserNavigateTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY, security);
    const result = await tool.execute({ url: "https://example.com/" });
    expect(result).toMatchObject({ url: expect.any(String), title: expect.any(String) });
  });

  test("denial message includes the blocked hostname for AI context", async () => {
    const driver = createMockDriver();
    const security = compileNavigationSecurity();
    const tool = createBrowserNavigateTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY, security);
    const result = (await tool.execute({ url: "https://10.0.0.1/api" })) as {
      error: string;
      code: string;
    };
    expect(result.code).toBe("PERMISSION");
    expect(result.error).toContain("10.0.0.1");
  });
});
