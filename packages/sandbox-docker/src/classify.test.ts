import { describe, expect, test } from "bun:test";
import { classifyDockerError } from "./classify.js";

describe("classifyDockerError", () => {
  test("classifies image not found as CRASH", () => {
    const result = classifyDockerError(new Error("image not found: myimage"), 100);
    expect(result.code).toBe("CRASH");
  });

  test("classifies no such image as CRASH", () => {
    const result = classifyDockerError(new Error("no such image: ubuntu:99"), 50);
    expect(result.code).toBe("CRASH");
  });

  test("classifies cannot connect as CRASH", () => {
    const result = classifyDockerError(new Error("Cannot connect to Docker daemon"), 10);
    expect(result.code).toBe("CRASH");
  });

  test("classifies socket not found as CRASH", () => {
    const result = classifyDockerError(new Error("ENOENT: /var/run/docker.sock not found"), 5);
    expect(result.code).toBe("CRASH");
  });

  test("classifies container not running as CRASH", () => {
    const result = classifyDockerError(new Error("container abc123 is not running"), 200);
    expect(result.code).toBe("CRASH");
  });

  test("falls back to cloud classifier for timeout", () => {
    const result = classifyDockerError(new Error("Request timeout"), 5000);
    expect(result.code).toBe("TIMEOUT");
  });

  test("falls back to cloud classifier for OOM", () => {
    const result = classifyDockerError(new Error("Out of memory"), 3000);
    expect(result.code).toBe("OOM");
  });

  test("falls back to cloud classifier for permission", () => {
    const result = classifyDockerError(new Error("permission denied"), 100);
    expect(result.code).toBe("PERMISSION");
  });

  test("falls back to CRASH for unknown errors", () => {
    const result = classifyDockerError(new Error("something went wrong"), 100);
    expect(result.code).toBe("CRASH");
  });

  test("handles string errors", () => {
    const result = classifyDockerError("image not found", 100);
    expect(result.code).toBe("CRASH");
  });

  test("preserves durationMs", () => {
    const result = classifyDockerError(new Error("image not found"), 42);
    expect(result.durationMs).toBe(42);
  });
});
