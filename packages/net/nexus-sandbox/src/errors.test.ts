import { describe, expect, test } from "bun:test";
import {
  healthTimeoutError,
  portInUseError,
  shutdownTimeoutError,
  spawnFailedError,
} from "./errors.js";

describe("error factories", () => {
  test("healthTimeoutError → TIMEOUT, retryable, with context", () => {
    const err = healthTimeoutError("http://127.0.0.1:2026", 5000);
    expect(err.code).toBe("TIMEOUT");
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("health");
    expect(err.message).toContain("5000");
    expect(err.context).toMatchObject({ baseUrl: "http://127.0.0.1:2026", timeoutMs: 5000 });
  });

  test("portInUseError → CONFLICT, retryable=true (per RETRYABLE_DEFAULTS)", () => {
    const err = portInUseError(2026);
    expect(err.code).toBe("CONFLICT");
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("2026");
    expect(err.context).toMatchObject({ port: 2026 });
  });

  test("spawnFailedError → EXTERNAL with stderr in context", () => {
    const err = spawnFailedError({ exitCode: 127, stderr: "command not found: uvx" });
    expect(err.code).toBe("EXTERNAL");
    expect(err.message).toContain("spawn");
    expect(err.context).toMatchObject({ exitCode: 127, stderr: "command not found: uvx" });
  });

  test("spawnFailedError preserves cause", () => {
    const cause = new Error("ENOENT");
    const err = spawnFailedError({ cause });
    expect(err.cause).toBe(cause);
  });

  test("shutdownTimeoutError → TIMEOUT not retryable", () => {
    const err = shutdownTimeoutError(1234, 5000);
    expect(err.code).toBe("TIMEOUT");
    expect(err.retryable).toBe(false);
    expect(err.context).toMatchObject({ pid: 1234, drainMs: 5000 });
  });
});
