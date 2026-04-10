import { describe, expect, mock, test } from "bun:test";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { createMockDriver } from "../test-helpers.js";
import { createBrowserTabNewTool } from "./tab-new.js";

describe("browser_tab_new", () => {
  test("opens a new blank tab", async () => {
    const driver = createMockDriver();
    const tool = createBrowserTabNewTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({});
    expect(result).toMatchObject({
      tabId: expect.any(String),
      url: expect.any(String),
      title: expect.any(String),
    });
  });

  test("opens a new tab with URL", async () => {
    const driver = createMockDriver();
    const tool = createBrowserTabNewTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ url: "https://example.com" });
    expect(result).toMatchObject({ tabId: expect.any(String) });
  });

  test("rejects non-string url", async () => {
    const driver = createMockDriver();
    const tool = createBrowserTabNewTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ url: 42 });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("returns error on driver failure", async () => {
    const driver = createMockDriver({ failWith: "INTERNAL" });
    const tool = createBrowserTabNewTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({});
    expect(result).toMatchObject({ code: "INTERNAL" });
  });

  test("rejects timeout below minimum", async () => {
    const driver = createMockDriver();
    const tool = createBrowserTabNewTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ timeout: 500 });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects timeout above maximum", async () => {
    const driver = createMockDriver();
    const tool = createBrowserTabNewTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ timeout: 120_000 });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });
});

describe("browser_tab_new — isUrlAllowed callback", () => {
  test("tab-new without isUrlAllowed allows all URLs", async () => {
    const driver = createMockDriver();
    const tool = createBrowserTabNewTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ url: "https://192.168.1.1/admin" });
    // No policy = allowed
    expect(result).toMatchObject({ tabId: expect.any(String) });
  });

  test("tab-new with isUrlAllowed returning false blocks navigation", async () => {
    const driver = createMockDriver();
    const tool = createBrowserTabNewTool(
      driver,
      "browser",
      DEFAULT_UNSANDBOXED_POLICY,
      () => false,
    );
    const result = await tool.execute({ url: "https://blocked.com/" });
    expect(result).toMatchObject({ code: "PERMISSION" });
  });

  test("tab-new with isUrlAllowed returning Promise<false> blocks async", async () => {
    const driver = createMockDriver();
    const tool = createBrowserTabNewTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY, () =>
      Promise.resolve(false),
    );
    const result = await tool.execute({ url: "https://blocked.com/" });
    expect(result).toMatchObject({ code: "PERMISSION" });
  });

  test("tab-new with isUrlAllowed throwing propagates error", async () => {
    const driver = createMockDriver();
    const tool = createBrowserTabNewTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY, () => {
      throw new Error("policy check failed");
    });
    await expect(tool.execute({ url: "https://example.com" })).rejects.toThrow(
      "policy check failed",
    );
  });

  test("blocked tab-new does not call driver.tabNew", async () => {
    const tabNewMock = mock(() => ({
      ok: true as const,
      value: { tabId: "tab-1", url: "https://example.com", title: "Test" },
    }));
    const driver = { ...createMockDriver(), tabNew: tabNewMock };
    const tool = createBrowserTabNewTool(
      driver,
      "browser",
      DEFAULT_UNSANDBOXED_POLICY,
      () => false,
    );
    await tool.execute({ url: "https://example.com" });
    expect(tabNewMock).not.toHaveBeenCalled();
  });

  test("no-url tab open is unaffected by isUrlAllowed", async () => {
    const tool = createBrowserTabNewTool(
      createMockDriver(),
      "browser",
      DEFAULT_UNSANDBOXED_POLICY,
      () => false,
    );
    // No url = isUrlAllowed not called
    const result = await tool.execute({});
    expect(result).toMatchObject({ tabId: expect.any(String) });
  });
});
