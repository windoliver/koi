/**
 * Tests for NexusFileSystemConfig validation.
 */

import { describe, expect, test } from "bun:test";
import { validateNexusFileSystemConfig } from "./validate-config.js";

describe("validateNexusFileSystemConfig", () => {
  test("accepts valid config", () => {
    const result = validateNexusFileSystemConfig({ url: "http://localhost:3100" });
    expect(result.ok).toBe(true);
  });

  test("accepts config with all optional fields", () => {
    const result = validateNexusFileSystemConfig({
      url: "http://localhost:3100",
      apiKey: "sk-test",
      mountPoint: "workspace/agent1",
      deadlineMs: 30000,
      retries: 3,
    });
    expect(result.ok).toBe(true);
  });

  test("rejects null config", () => {
    const result = validateNexusFileSystemConfig(null);
    expect(result.ok).toBe(false);
  });

  test("rejects non-object config", () => {
    const result = validateNexusFileSystemConfig("not an object");
    expect(result.ok).toBe(false);
  });

  test("rejects missing url", () => {
    const result = validateNexusFileSystemConfig({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("rejects empty url", () => {
    const result = validateNexusFileSystemConfig({ url: "" });
    expect(result.ok).toBe(false);
  });

  test("rejects unix:// url (not implemented)", () => {
    const result = validateNexusFileSystemConfig({ url: "unix:///tmp/nexus.sock" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("http://");
  });

  test("rejects ftp:// url", () => {
    const result = validateNexusFileSystemConfig({ url: "ftp://example.com" });
    expect(result.ok).toBe(false);
  });

  test("accepts https:// url", () => {
    const result = validateNexusFileSystemConfig({ url: "https://nexus.example.com" });
    expect(result.ok).toBe(true);
  });

  test("rejects mountPoint with ..", () => {
    const result = validateNexusFileSystemConfig({
      url: "http://localhost",
      mountPoint: "../escape",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("..");
  });

  test("rejects non-string mountPoint", () => {
    const result = validateNexusFileSystemConfig({ url: "http://localhost", mountPoint: 42 });
    expect(result.ok).toBe(false);
  });

  test("rejects non-positive deadlineMs", () => {
    const result = validateNexusFileSystemConfig({ url: "http://localhost", deadlineMs: 0 });
    expect(result.ok).toBe(false);
  });

  test("rejects negative deadlineMs", () => {
    const result = validateNexusFileSystemConfig({ url: "http://localhost", deadlineMs: -1 });
    expect(result.ok).toBe(false);
  });

  test("rejects negative retries", () => {
    const result = validateNexusFileSystemConfig({ url: "http://localhost", retries: -1 });
    expect(result.ok).toBe(false);
  });

  test("accepts zero retries", () => {
    const result = validateNexusFileSystemConfig({ url: "http://localhost", retries: 0 });
    expect(result.ok).toBe(true);
  });
});
