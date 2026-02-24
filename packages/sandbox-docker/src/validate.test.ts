import { describe, expect, test } from "bun:test";
import { validateDockerConfig } from "./validate.js";

describe("validateDockerConfig", () => {
  test("returns ok with default config", () => {
    const result = validateDockerConfig({});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.socketPath).toBe("/var/run/docker.sock");
      expect(result.value.image).toBe("ubuntu:22.04");
    }
  });

  test("uses custom socketPath when provided", () => {
    const result = validateDockerConfig({ socketPath: "/custom/docker.sock" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.socketPath).toBe("/custom/docker.sock");
    }
  });

  test("uses custom image when provided", () => {
    const result = validateDockerConfig({ image: "node:20" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.image).toBe("node:20");
    }
  });

  test("returns error for empty socketPath", () => {
    const result = validateDockerConfig({ socketPath: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("socket path");
    }
  });

  test("returns error for empty image", () => {
    const result = validateDockerConfig({ image: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("image");
    }
  });

  test("preserves both custom values", () => {
    const result = validateDockerConfig({
      socketPath: "/tmp/docker.sock",
      image: "alpine:3.19",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.socketPath).toBe("/tmp/docker.sock");
      expect(result.value.image).toBe("alpine:3.19");
    }
  });
});
