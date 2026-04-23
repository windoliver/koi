import { describe, expect, it } from "bun:test";
import type { ModelResponse } from "@koi/core/middleware";
import type { Validator } from "./types.js";
import { runValidators } from "./validators.js";

const mockResponse = (): ModelResponse => ({
  content: "hello",
  model: "test",
});

describe("runValidators", () => {
  it("returns empty array when no validators", async () => {
    const result = await runValidators([], mockResponse());
    expect(result).toEqual([]);
  });

  it("returns empty array when all validators pass", async () => {
    const validators: Validator[] = [
      { name: "v1", validate: () => ({ valid: true }) },
      { name: "v2", validate: () => ({ valid: true }) },
    ];
    const result = await runValidators(validators, mockResponse());
    expect(result).toEqual([]);
  });

  it("returns errors from failing validators", async () => {
    const validators: Validator[] = [
      {
        name: "v1",
        validate: () => ({
          valid: false,
          errors: [{ validator: "v1", message: "bad output" }],
        }),
      },
    ];
    const result = await runValidators(validators, mockResponse());
    expect(result).toHaveLength(1);
    expect(result[0]?.validator).toBe("v1");
    expect(result[0]?.message).toBe("bad output");
  });

  it("collects errors from multiple failing validators", async () => {
    const validators: Validator[] = [
      {
        name: "v1",
        validate: () => ({ valid: false, errors: [{ validator: "v1", message: "e1" }] }),
      },
      {
        name: "v2",
        validate: () => ({ valid: false, errors: [{ validator: "v2", message: "e2" }] }),
      },
    ];
    const result = await runValidators(validators, mockResponse());
    expect(result).toHaveLength(2);
  });

  it("supports async validators", async () => {
    const validators: Validator[] = [
      {
        name: "v1",
        validate: async () => ({
          valid: false,
          errors: [{ validator: "v1", message: "async fail" }],
        }),
      },
    ];
    const result = await runValidators(validators, mockResponse());
    expect(result).toHaveLength(1);
  });
});
