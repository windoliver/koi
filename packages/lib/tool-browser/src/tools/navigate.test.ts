import { describe, expect, mock, test } from "bun:test";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { createMockDriver } from "../test-helpers.js";
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

describe("browser_navigate — isUrlAllowed callback", () => {
  test("navigate without isUrlAllowed allows all URLs", async () => {
    const driver = createMockDriver();
    const tool = createBrowserNavigateTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ url: "https://192.168.1.1/admin" });
    // No policy = allowed (driver-level handling only)
    expect(result).toMatchObject({ url: expect.any(String) });
  });

  test("navigate with isUrlAllowed returning false blocks navigation", async () => {
    const driver = createMockDriver();
    const tool = createBrowserNavigateTool(
      driver,
      "browser",
      DEFAULT_UNSANDBOXED_POLICY,
      () => false,
    );
    const result = await tool.execute({ url: "https://blocked.com/" });
    expect(result).toMatchObject({ code: "PERMISSION" });
  });

  test("navigate with isUrlAllowed returning Promise<false> blocks async", async () => {
    const driver = createMockDriver();
    const tool = createBrowserNavigateTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY, () =>
      Promise.resolve(false),
    );
    const result = await tool.execute({ url: "https://blocked.com/" });
    expect(result).toMatchObject({ code: "PERMISSION" });
  });

  test("navigate with isUrlAllowed throwing propagates error", async () => {
    const driver = createMockDriver();
    const tool = createBrowserNavigateTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY, () => {
      throw new Error("policy check failed");
    });
    await expect(tool.execute({ url: "https://example.com" })).rejects.toThrow(
      "policy check failed",
    );
  });

  test("blocked navigation does not call driver.navigate", async () => {
    const navigateMock = mock(() => ({
      ok: true as const,
      value: { url: "https://example.com", title: "Test" },
    }));
    const driver = { ...createMockDriver(), navigate: navigateMock };
    const tool = createBrowserNavigateTool(
      driver,
      "browser",
      DEFAULT_UNSANDBOXED_POLICY,
      () => false,
    );
    await tool.execute({ url: "https://example.com" });
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
