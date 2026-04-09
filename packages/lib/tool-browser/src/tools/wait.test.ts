import { describe, expect, test } from "bun:test";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { createMockDriver } from "../test-helpers.js";
import { createBrowserWaitTool } from "./wait.js";

describe("browser_wait", () => {
  test("waits for timeout", async () => {
    const driver = createMockDriver();
    const tool = createBrowserWaitTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ kind: "timeout", timeout: 100 });
    expect(result).toMatchObject({ success: true });
  });

  test("waits for selector", async () => {
    const driver = createMockDriver();
    const tool = createBrowserWaitTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ kind: "selector", selector: "#submit" });
    expect(result).toMatchObject({ success: true });
  });

  test("waits for navigation", async () => {
    const driver = createMockDriver();
    const tool = createBrowserWaitTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ kind: "navigation" });
    expect(result).toMatchObject({ success: true });
  });

  test("rejects missing kind", async () => {
    const driver = createMockDriver();
    const tool = createBrowserWaitTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({});
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects invalid kind", async () => {
    const driver = createMockDriver();
    const tool = createBrowserWaitTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ kind: "idle" });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects timeout kind without timeout value", async () => {
    const driver = createMockDriver();
    const tool = createBrowserWaitTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ kind: "timeout" });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects selector kind without selector", async () => {
    const driver = createMockDriver();
    const tool = createBrowserWaitTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ kind: "selector" });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("returns error on driver failure", async () => {
    const driver = createMockDriver({ failWith: "TIMEOUT" });
    const tool = createBrowserWaitTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ kind: "timeout", timeout: 100 });
    expect(result).toMatchObject({ code: "TIMEOUT" });
  });
});
