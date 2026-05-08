import { describe, expect, test } from "bun:test";
import { createSandboxIpcParseError, SandboxIpcParseError } from "./errors.js";

describe("SandboxIpcParseError", () => {
  test("captures path and reason", () => {
    const error = createSandboxIpcParseError("timeoutMs", "expected a positive number");

    expect(error).toBeInstanceOf(SandboxIpcParseError);
    expect(error.name).toBe("SandboxIpcParseError");
    expect(error.path).toBe("timeoutMs");
    expect(error.reason).toBe("expected a positive number");
    expect(error.message).toContain("timeoutMs");
  });
});
