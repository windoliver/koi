import { describe, expect, test } from "bun:test";
import { createMockDriver } from "../test-helpers.js";
import { compileNavigationSecurity } from "../url-security.js";
import { createBrowserTabNewTool } from "./tab-new.js";

describe("browser_tab_new — security config wiring", () => {
  test("blocks private IP in tab URL (PERMISSION)", async () => {
    const driver = createMockDriver();
    const security = compileNavigationSecurity();
    const tool = createBrowserTabNewTool(driver, "browser", "verified", security);
    const result = await tool.execute({ url: "https://192.168.1.1/admin" });
    expect(result).toMatchObject({ code: "PERMISSION" });
  });

  test("blocks disallowed protocol in tab URL", async () => {
    const driver = createMockDriver();
    const security = compileNavigationSecurity({ allowedProtocols: ["https:"] });
    const tool = createBrowserTabNewTool(driver, "browser", "verified", security);
    const result = await tool.execute({ url: "http://example.com" });
    expect(result).toMatchObject({ code: "PERMISSION" });
  });

  test("blocks domain outside allowlist in tab URL", async () => {
    const driver = createMockDriver();
    const security = compileNavigationSecurity({ allowedDomains: ["allowed.com"] });
    const tool = createBrowserTabNewTool(driver, "browser", "verified", security);
    const result = await tool.execute({ url: "https://blocked.com/" });
    expect(result).toMatchObject({ code: "PERMISSION" });
  });

  test("allows tab URL matching domain allowlist", async () => {
    const driver = createMockDriver();
    const security = compileNavigationSecurity({ allowedDomains: ["example.com"] });
    const tool = createBrowserTabNewTool(driver, "browser", "verified", security);
    const result = await tool.execute({ url: "https://example.com/" });
    expect(result).toMatchObject({ tabId: expect.any(String) });
  });

  test("denial message includes the blocked hostname for AI context", async () => {
    const driver = createMockDriver();
    const security = compileNavigationSecurity();
    const tool = createBrowserTabNewTool(driver, "browser", "verified", security);
    const result = (await tool.execute({ url: "https://10.0.0.1/api" })) as {
      error: string;
      code: string;
    };
    expect(result.code).toBe("PERMISSION");
    expect(result.error).toContain("10.0.0.1");
  });

  test("no-url tab open is unaffected by security config", async () => {
    const driver = createMockDriver();
    const security = compileNavigationSecurity({ allowedDomains: ["allowed.com"] });
    const tool = createBrowserTabNewTool(driver, "browser", "verified", security);
    const result = await tool.execute({});
    expect(result).toMatchObject({ tabId: expect.any(String) });
  });
});

describe("browser_tab_new", () => {
  test("opens a new blank tab", async () => {
    const driver = createMockDriver();
    const tool = createBrowserTabNewTool(driver, "browser", "verified");
    const result = await tool.execute({});
    expect(result).toMatchObject({
      tabId: expect.any(String),
      url: expect.any(String),
      title: expect.any(String),
    });
  });

  test("opens a new tab with URL", async () => {
    const driver = createMockDriver();
    const tool = createBrowserTabNewTool(driver, "browser", "verified");
    const result = await tool.execute({ url: "https://example.com" });
    expect(result).toMatchObject({ tabId: expect.any(String) });
  });

  test("rejects non-string url", async () => {
    const driver = createMockDriver();
    const tool = createBrowserTabNewTool(driver, "browser", "verified");
    const result = await tool.execute({ url: 42 });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("returns error on driver failure", async () => {
    const driver = createMockDriver({ failWith: "INTERNAL" });
    const tool = createBrowserTabNewTool(driver, "browser", "verified");
    const result = await tool.execute({});
    expect(result).toMatchObject({ code: "INTERNAL" });
  });

  test("rejects timeout below minimum", async () => {
    const driver = createMockDriver();
    const tool = createBrowserTabNewTool(driver, "browser", "verified");
    const result = await tool.execute({ timeout: 500 });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects timeout above maximum", async () => {
    const driver = createMockDriver();
    const tool = createBrowserTabNewTool(driver, "browser", "verified");
    const result = await tool.execute({ timeout: 120_000 });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });
});
