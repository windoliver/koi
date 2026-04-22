import { describe, expect, it, mock } from "bun:test";
import type { ModelResponse } from "@koi/core/middleware";
import { KoiRuntimeError } from "@koi/errors";
import { runGates } from "./gate.js";
import type { Gate } from "./types.js";

const mockResponse = (): ModelResponse => ({ content: "ok", model: "test" });

describe("runGates", () => {
  it("resolves when no gates", async () => {
    await expect(runGates([], mockResponse())).resolves.toBeUndefined();
  });

  it("resolves when all gates pass", async () => {
    const gates: Gate[] = [
      { name: "g1", validate: () => ({ valid: true }) },
      { name: "g2", validate: () => ({ valid: true }) },
    ];
    await expect(runGates(gates, mockResponse())).resolves.toBeUndefined();
  });

  it("throws KoiRuntimeError on gate failure", async () => {
    const gates: Gate[] = [
      {
        name: "safety",
        validate: () => ({ valid: false, errors: [{ validator: "safety", message: "unsafe" }] }),
      },
    ];
    await expect(runGates(gates, mockResponse())).rejects.toBeInstanceOf(KoiRuntimeError);
  });

  it("throws on first failing gate — stops evaluation", async () => {
    const second = mock(() => ({ valid: true }));
    const gates: Gate[] = [
      {
        name: "g1",
        validate: () => ({ valid: false, errors: [{ validator: "g1", message: "fail" }] }),
      },
      { name: "g2", validate: second },
    ];
    await expect(runGates(gates, mockResponse())).rejects.toBeInstanceOf(KoiRuntimeError);
    expect(second).not.toHaveBeenCalled();
  });

  it("calls onGateFail callback with gate and errors", async () => {
    const onGateFail = mock(() => {});
    const gates: Gate[] = [
      {
        name: "g1",
        validate: () => ({ valid: false, errors: [{ validator: "g1", message: "fail" }] }),
      },
    ];
    await expect(runGates(gates, mockResponse(), onGateFail)).rejects.toBeInstanceOf(
      KoiRuntimeError,
    );
    expect(onGateFail).toHaveBeenCalledWith(gates[0], [{ validator: "g1", message: "fail" }]);
  });
});
