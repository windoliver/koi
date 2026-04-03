/**
 * Overflow recovery tests (ported from v1).
 */

import { describe, expect, it } from "bun:test";
import { wrapWithOverflowRecovery } from "./overflow-recovery.js";

/** Create an error that looks like a context overflow. */
function overflowError(): Error {
  const err = new Error("context_length_exceeded");
  (err as unknown as Record<string, unknown>).code = "context_length_exceeded";
  return err;
}

describe("wrapWithOverflowRecovery", () => {
  it("returns result on first success", async () => {
    const result = await wrapWithOverflowRecovery(
      async () => 42,
      async () => {},
      2,
    );
    expect(result).toBe(42);
  });

  it("retries on overflow error and succeeds", async () => {
    let attempts = 0; // let: counter for test assertions
    const result = await wrapWithOverflowRecovery(
      async () => {
        attempts++;
        if (attempts === 1) throw overflowError();
        return "recovered";
      },
      async () => {},
      2,
    );
    expect(result).toBe("recovered");
    expect(attempts).toBe(2);
  });

  it("calls recover on overflow", async () => {
    let recovered = false; // let: flag for test assertions
    let attempts = 0; // let: counter
    await wrapWithOverflowRecovery(
      async () => {
        attempts++;
        if (attempts === 1) throw overflowError();
        return "ok";
      },
      async () => {
        recovered = true;
      },
      2,
    );
    expect(recovered).toBe(true);
  });

  it("rethrows overflow after retries exhausted", async () => {
    await expect(
      wrapWithOverflowRecovery(
        async () => {
          throw overflowError();
        },
        async () => {},
        2,
      ),
    ).rejects.toThrow("context_length_exceeded");
  });

  it("rethrows non-overflow errors immediately", async () => {
    await expect(
      wrapWithOverflowRecovery(
        async () => {
          throw new Error("network error");
        },
        async () => {},
        2,
      ),
    ).rejects.toThrow("network error");
  });

  it("does not call recover for non-overflow errors", async () => {
    let recovered = false; // let: flag
    try {
      await wrapWithOverflowRecovery(
        async () => {
          throw new Error("unrelated");
        },
        async () => {
          recovered = true;
        },
        2,
      );
    } catch {
      // expected
    }
    expect(recovered).toBe(false);
  });

  it("handles maxRetries = 0 (no retries)", async () => {
    await expect(
      wrapWithOverflowRecovery(
        async () => {
          throw overflowError();
        },
        async () => {},
        0,
      ),
    ).rejects.toThrow("context_length_exceeded");
  });

  it("preserves original overflow error as cause when recover() throws", async () => {
    try {
      await wrapWithOverflowRecovery(
        async () => {
          throw overflowError();
        },
        async () => {
          throw new Error("summarizer unavailable");
        },
        2,
      );
      expect.unreachable("should have thrown");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(Error);
      const error = err as Error;
      expect(error.message).toBe("Recovery failed after context overflow");
      expect(error.cause).toBeInstanceOf(Error);
      expect((error.cause as Error).message).toBe("context_length_exceeded");
    }
  });
});
