import { describe, expect, test } from "bun:test";
import { classifyCloudError } from "./classify-error.js";

describe("classifyCloudError", () => {
  describe("TIMEOUT classification", () => {
    test("classifies 'timeout' message", () => {
      const result = classifyCloudError(new Error("Request timeout"), 5000);
      expect(result.code).toBe("TIMEOUT");
      expect(result.durationMs).toBe(5000);
    });

    test("classifies 'timed out' message", () => {
      const result = classifyCloudError(new Error("Operation timed out"), 3000);
      expect(result.code).toBe("TIMEOUT");
    });

    test("classifies 'deadline exceeded' message", () => {
      const result = classifyCloudError(new Error("Deadline exceeded"), 1000);
      expect(result.code).toBe("TIMEOUT");
    });

    test("classifies 'execution time limit' message", () => {
      const result = classifyCloudError(new Error("Execution time limit reached"), 2000);
      expect(result.code).toBe("TIMEOUT");
    });
  });

  describe("OOM classification", () => {
    test("classifies 'out of memory' message", () => {
      const result = classifyCloudError(new Error("Out of memory"), 1000);
      expect(result.code).toBe("OOM");
    });

    test("classifies 'OOM' message", () => {
      const result = classifyCloudError(new Error("Process OOM killed"), 1500);
      expect(result.code).toBe("OOM");
    });

    test("classifies 'memory limit' message", () => {
      const result = classifyCloudError(new Error("Memory limit exceeded"), 2000);
      expect(result.code).toBe("OOM");
    });

    test("classifies signal 9 killed message", () => {
      const result = classifyCloudError(new Error("Process killed signal 9"), 1000);
      expect(result.code).toBe("OOM");
    });
  });

  describe("PERMISSION classification", () => {
    test("classifies 'unauthorized' message", () => {
      const result = classifyCloudError(new Error("Unauthorized"), 100);
      expect(result.code).toBe("PERMISSION");
    });

    test("classifies 'forbidden' message", () => {
      const result = classifyCloudError(new Error("Forbidden resource"), 50);
      expect(result.code).toBe("PERMISSION");
    });

    test("classifies '401' message", () => {
      const result = classifyCloudError(new Error("HTTP 401"), 100);
      expect(result.code).toBe("PERMISSION");
    });

    test("classifies 'invalid token' message", () => {
      const result = classifyCloudError(new Error("Invalid token provided"), 100);
      expect(result.code).toBe("PERMISSION");
    });

    test("classifies 'api key' message", () => {
      const result = classifyCloudError(new Error("Missing api key"), 100);
      expect(result.code).toBe("PERMISSION");
    });
  });

  describe("CRASH classification (default)", () => {
    test("classifies unknown errors as CRASH", () => {
      const result = classifyCloudError(new Error("Something went wrong"), 500);
      expect(result.code).toBe("CRASH");
    });

    test("classifies string errors", () => {
      const result = classifyCloudError("raw string error", 100);
      expect(result.code).toBe("CRASH");
      expect(result.message).toBe("raw string error");
    });

    test("classifies non-error objects", () => {
      const result = classifyCloudError({ code: 500 }, 200);
      expect(result.code).toBe("CRASH");
    });
  });

  describe("priority order", () => {
    test("TIMEOUT takes priority over PERMISSION", () => {
      const result = classifyCloudError(new Error("timeout while authenticating"), 1000);
      expect(result.code).toBe("TIMEOUT");
    });

    test("TIMEOUT takes priority over OOM", () => {
      const result = classifyCloudError(new Error("timeout: out of memory"), 1000);
      expect(result.code).toBe("TIMEOUT");
    });
  });

  test("preserves durationMs in result", () => {
    const result = classifyCloudError(new Error("crash"), 42);
    expect(result.durationMs).toBe(42);
  });

  test("extracts message from Error objects", () => {
    const result = classifyCloudError(new Error("specific error"), 100);
    expect(result.message).toBe("specific error");
  });
});
