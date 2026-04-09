import { describe, expect, test } from "bun:test";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { createMockDriver } from "../test-helpers.js";
import { createBrowserFillFormTool } from "./fill-form.js";

describe("browser_fill_form", () => {
  test("fills multiple fields successfully", async () => {
    const driver = createMockDriver();
    const tool = createBrowserFillFormTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({
      fields: [
        { ref: "e3", value: "Alice" },
        { ref: "e4", value: "alice@example.com" },
      ],
    });
    expect(result).toMatchObject({ success: true, fieldsFilledCount: 2 });
  });

  test("rejects empty fields array", async () => {
    const driver = createMockDriver();
    const tool = createBrowserFillFormTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ fields: [] });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects invalid ref in fields", async () => {
    const driver = createMockDriver();
    const tool = createBrowserFillFormTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ fields: [{ ref: "email-input", value: "test" }] });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects missing value in field", async () => {
    const driver = createMockDriver();
    const tool = createBrowserFillFormTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ fields: [{ ref: "e3" }] });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects non-array fields", async () => {
    const driver = createMockDriver();
    const tool = createBrowserFillFormTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ fields: "not-an-array" });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("returns error on driver failure", async () => {
    const driver = createMockDriver({ failWith: "INTERNAL" });
    const tool = createBrowserFillFormTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ fields: [{ ref: "e3", value: "Alice" }] });
    expect(result).toMatchObject({ code: "INTERNAL" });
  });
});
