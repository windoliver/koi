import { describe, expect, it, mock } from "bun:test";
import type { ModelRequest, ModelResponse } from "@koi/core/middleware";
import { KoiRuntimeError } from "@koi/errors";
import { defaultRepairStrategy } from "./repair.js";
import { runWithRetry } from "./retry.js";
import type { Validator } from "./types.js";

const goodResponse: ModelResponse = { content: "valid", model: "test" };
const badResponse: ModelResponse = { content: "invalid", model: "test" };
const baseRequest: ModelRequest = {
  messages: [{ senderId: "user", content: [{ kind: "text", text: "hi" }], timestamp: 1 }],
};

const passingValidator: Validator = { name: "pass", validate: () => ({ valid: true }) };
const failingValidator: Validator = {
  name: "fail",
  validate: () => ({ valid: false, errors: [{ validator: "fail", message: "bad" }] }),
};

describe("runWithRetry", () => {
  it("returns response when validators all pass", async () => {
    const next = mock(async () => goodResponse);
    const result = await runWithRetry(baseRequest, next, {
      validators: [passingValidator],
      gates: [],
      repairStrategy: defaultRepairStrategy,
      validationMaxAttempts: 3,
      transportMaxAttempts: 2,
    });
    expect(result).toBe(goodResponse);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("retries on validation failure and succeeds on second attempt", async () => {
    let callCount = 0;
    const next = mock(async () => {
      callCount++;
      return callCount === 1 ? badResponse : goodResponse;
    });
    const validators: Validator[] = [
      {
        name: "check",
        validate: (r) =>
          r.content === "valid"
            ? { valid: true }
            : { valid: false, errors: [{ validator: "check", message: "not valid" }] },
      },
    ];
    const result = await runWithRetry(baseRequest, next, {
      validators,
      gates: [],
      repairStrategy: defaultRepairStrategy,
      validationMaxAttempts: 3,
      transportMaxAttempts: 2,
    });
    expect(result).toBe(goodResponse);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("throws KoiRuntimeError when validation budget exhausted", async () => {
    const next = mock(async () => badResponse);
    await expect(
      runWithRetry(baseRequest, next, {
        validators: [failingValidator],
        gates: [],
        repairStrategy: defaultRepairStrategy,
        validationMaxAttempts: 2,
        transportMaxAttempts: 2,
      }),
    ).rejects.toBeInstanceOf(KoiRuntimeError);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("retries on transport error within budget", async () => {
    let callCount = 0;
    const next = mock(async () => {
      callCount++;
      if (callCount === 1)
        throw {
          code: "RATE_LIMIT",
          message: "network",
          retryable: true,
        };
      return goodResponse;
    });
    const result = await runWithRetry(baseRequest, next, {
      validators: [],
      gates: [],
      repairStrategy: defaultRepairStrategy,
      validationMaxAttempts: 3,
      transportMaxAttempts: 2,
    });
    expect(result).toBe(goodResponse);
  });

  it("throws on transport error when budget exhausted", async () => {
    const next = mock(async () => {
      throw new Error("network");
    });
    await expect(
      runWithRetry(baseRequest, next, {
        validators: [],
        gates: [],
        repairStrategy: defaultRepairStrategy,
        validationMaxAttempts: 3,
        transportMaxAttempts: 0,
      }),
    ).rejects.toThrow("network");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("fires onRetry on each retry attempt", async () => {
    const onRetry = mock(() => {});
    const next = mock(async () => badResponse);
    await expect(
      runWithRetry(baseRequest, next, {
        validators: [failingValidator],
        gates: [],
        repairStrategy: defaultRepairStrategy,
        validationMaxAttempts: 3,
        transportMaxAttempts: 2,
        onRetry,
      }),
    ).rejects.toBeInstanceOf(KoiRuntimeError);
    expect(onRetry).toHaveBeenCalledTimes(2); // 3 attempts = 2 retries
  });

  it("second retry replaces prior feedback — only one feedback message", async () => {
    let lastRequest: ModelRequest = baseRequest;
    const next = mock(async (req: ModelRequest) => {
      lastRequest = req;
      return badResponse;
    });
    await expect(
      runWithRetry(baseRequest, next, {
        validators: [failingValidator],
        gates: [],
        repairStrategy: defaultRepairStrategy,
        validationMaxAttempts: 3,
        transportMaxAttempts: 2,
      }),
    ).rejects.toBeInstanceOf(KoiRuntimeError);
    // Last request sent (attempt 3) should have exactly 2 messages total
    // (1 original user message + 1 feedback slot, not growing)
    expect(lastRequest.messages.length).toBe(2);
  });
});
