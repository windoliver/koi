import { describe, expect, test } from "bun:test";
import { wrapWithOverflowRecovery } from "./overflow-recovery.js";

/** Create an error that isContextOverflowError() recognizes. */
function overflowError(): Error & { readonly code: string } {
  return Object.assign(new Error("context too long"), {
    code: "context_length_exceeded",
  } as const);
}

describe("wrapWithOverflowRecovery", () => {
  test("returns result when execute succeeds on first try", async () => {
    const result = await wrapWithOverflowRecovery(
      async () => "ok",
      async () => {},
      1,
    );
    expect(result).toBe("ok");
  });

  test("retries after context overflow error and succeeds", async () => {
    let callCount = 0;
    const execute = async (): Promise<string> => {
      callCount++;
      if (callCount === 1) throw overflowError();
      return "recovered";
    };

    let recoverCalled = false;
    const recover = async (): Promise<void> => {
      recoverCalled = true;
    };

    const result = await wrapWithOverflowRecovery(execute, recover, 1);
    expect(result).toBe("recovered");
    expect(recoverCalled).toBe(true);
    expect(callCount).toBe(2);
  });

  test("rethrows after exhausting max retries", async () => {
    const execute = async (): Promise<string> => {
      throw overflowError();
    };

    let recoverCount = 0;
    const recover = async (): Promise<void> => {
      recoverCount++;
    };

    await expect(wrapWithOverflowRecovery(execute, recover, 2)).rejects.toThrow("context too long");
    expect(recoverCount).toBe(2);
  });

  test("rethrows non-overflow errors immediately", async () => {
    const execute = async (): Promise<string> => {
      throw new Error("network failure");
    };

    let recoverCalled = false;
    const recover = async (): Promise<void> => {
      recoverCalled = true;
    };

    await expect(wrapWithOverflowRecovery(execute, recover, 1)).rejects.toThrow("network failure");
    expect(recoverCalled).toBe(false);
  });

  test("respects maxRetries=0 (no retries, rethrows immediately)", async () => {
    const execute = async (): Promise<string> => {
      throw overflowError();
    };

    let recoverCalled = false;
    const recover = async (): Promise<void> => {
      recoverCalled = true;
    };

    await expect(wrapWithOverflowRecovery(execute, recover, 0)).rejects.toThrow("context too long");
    expect(recoverCalled).toBe(false);
  });
});
