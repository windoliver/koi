import { describe, expect, test } from "bun:test";
import { createMockDriver } from "../test-helpers.js";
import { createBrowserUploadTool } from "./upload.js";

describe("browser_upload", () => {
  test("uploads files successfully", async () => {
    const driver = createMockDriver();
    const tool = createBrowserUploadTool(driver, "browser", "verified");
    const result = await tool.execute({
      ref: "e3",
      files: [{ content: "SGVsbG8gV29ybGQ=", name: "hello.txt", mimeType: "text/plain" }],
    });
    expect(result).toMatchObject({ success: true });
  });

  test("uploads multiple files", async () => {
    const driver = createMockDriver();
    const tool = createBrowserUploadTool(driver, "browser", "verified");
    const result = await tool.execute({
      ref: "e3",
      files: [
        { content: "SGVsbG8=", name: "file1.txt" },
        { content: "V29ybGQ=", name: "file2.txt" },
      ],
    });
    expect(result).toMatchObject({ success: true });
  });

  test("rejects missing ref", async () => {
    const driver = createMockDriver();
    const tool = createBrowserUploadTool(driver, "browser", "verified");
    const result = await tool.execute({
      files: [{ content: "SGVsbG8=", name: "hello.txt" }],
    });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects invalid ref format", async () => {
    const driver = createMockDriver();
    const tool = createBrowserUploadTool(driver, "browser", "verified");
    const result = await tool.execute({
      ref: "not-a-ref",
      files: [{ content: "SGVsbG8=", name: "hello.txt" }],
    });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects missing files array", async () => {
    const driver = createMockDriver();
    const tool = createBrowserUploadTool(driver, "browser", "verified");
    const result = await tool.execute({ ref: "e3" });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects empty files array", async () => {
    const driver = createMockDriver();
    const tool = createBrowserUploadTool(driver, "browser", "verified");
    const result = await tool.execute({ ref: "e3", files: [] });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects file missing content", async () => {
    const driver = createMockDriver();
    const tool = createBrowserUploadTool(driver, "browser", "verified");
    const result = await tool.execute({
      ref: "e3",
      files: [{ name: "hello.txt" }],
    });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects file missing name", async () => {
    const driver = createMockDriver();
    const tool = createBrowserUploadTool(driver, "browser", "verified");
    const result = await tool.execute({
      ref: "e3",
      files: [{ content: "SGVsbG8=" }],
    });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("returns error on driver failure", async () => {
    const driver = createMockDriver({ failWith: "INTERNAL" });
    const tool = createBrowserUploadTool(driver, "browser", "verified");
    const result = await tool.execute({
      ref: "e3",
      files: [{ content: "SGVsbG8=", name: "hello.txt" }],
    });
    expect(result).toMatchObject({ code: "INTERNAL" });
  });

  test("uses correct tool name with prefix", () => {
    const driver = createMockDriver();
    const tool = createBrowserUploadTool(driver, "browser", "verified");
    expect(tool.descriptor.name).toBe("browser_upload");
  });

  test("uses custom prefix", () => {
    const driver = createMockDriver();
    const tool = createBrowserUploadTool(driver, "wb", "verified");
    expect(tool.descriptor.name).toBe("wb_upload");
  });
});
