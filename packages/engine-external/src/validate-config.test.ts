import { describe, expect, test } from "bun:test";
import { validateExternalAdapterConfig } from "./validate-config.js";

describe("validateExternalAdapterConfig", () => {
  test("valid config passes", () => {
    const result = validateExternalAdapterConfig({
      command: "echo",
      args: ["hello"],
      timeoutMs: 5000,
      maxOutputBytes: 1024,
      mode: "single-shot",
    });

    expect(result.ok).toBe(true);
  });

  test("minimal valid config (command only)", () => {
    const result = validateExternalAdapterConfig({ command: "echo" });
    expect(result.ok).toBe(true);
  });

  test("null config fails", () => {
    const result = validateExternalAdapterConfig(null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
  });

  test("undefined config fails", () => {
    const result = validateExternalAdapterConfig(undefined);
    expect(result.ok).toBe(false);
  });

  test("missing command fails", () => {
    const result = validateExternalAdapterConfig({ args: ["hello"] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("command");
  });

  test("empty command fails", () => {
    const result = validateExternalAdapterConfig({ command: "" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("command");
  });

  test("non-string args fails", () => {
    const result = validateExternalAdapterConfig({ command: "echo", args: [1, 2] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("args");
  });

  test("negative timeoutMs fails", () => {
    const result = validateExternalAdapterConfig({ command: "echo", timeoutMs: -1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("timeoutMs");
  });

  test("zero timeoutMs passes (means no timeout)", () => {
    const result = validateExternalAdapterConfig({ command: "echo", timeoutMs: 0 });
    expect(result.ok).toBe(true);
  });

  test("zero maxOutputBytes fails", () => {
    const result = validateExternalAdapterConfig({ command: "echo", maxOutputBytes: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("maxOutputBytes");
  });

  test("negative maxOutputBytes fails", () => {
    const result = validateExternalAdapterConfig({ command: "echo", maxOutputBytes: -100 });
    expect(result.ok).toBe(false);
  });

  test("invalid mode fails", () => {
    const result = validateExternalAdapterConfig({ command: "echo", mode: "streaming" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("mode");
  });

  test("valid long-lived mode passes", () => {
    const result = validateExternalAdapterConfig({ command: "cat", mode: "long-lived" });
    expect(result.ok).toBe(true);
  });

  test("invalid shutdown config fails", () => {
    const result = validateExternalAdapterConfig({ command: "echo", shutdown: "fast" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("shutdown");
  });

  test("negative gracePeriodMs fails", () => {
    const result = validateExternalAdapterConfig({
      command: "echo",
      shutdown: { gracePeriodMs: -1 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("gracePeriodMs");
  });

  test("valid shutdown config passes", () => {
    const result = validateExternalAdapterConfig({
      command: "echo",
      shutdown: { signal: 15, gracePeriodMs: 3000 },
    });
    expect(result.ok).toBe(true);
  });

  test("negative noOutputTimeoutMs fails", () => {
    const result = validateExternalAdapterConfig({ command: "echo", noOutputTimeoutMs: -1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("noOutputTimeoutMs");
  });

  test("zero noOutputTimeoutMs passes (disabled)", () => {
    const result = validateExternalAdapterConfig({ command: "echo", noOutputTimeoutMs: 0 });
    expect(result.ok).toBe(true);
  });

  test("positive noOutputTimeoutMs passes", () => {
    const result = validateExternalAdapterConfig({ command: "echo", noOutputTimeoutMs: 5000 });
    expect(result.ok).toBe(true);
  });
});
