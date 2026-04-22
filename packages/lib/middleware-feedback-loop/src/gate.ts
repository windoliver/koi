import type { ModelResponse, ToolResponse } from "@koi/core/middleware";
import { KoiRuntimeError } from "@koi/errors";
import type { Gate, ValidationError } from "./types.js";

export async function runGates(
  gates: readonly Gate[],
  response: ModelResponse | ToolResponse,
  onGateFail?: (gate: Gate, errors: readonly ValidationError[]) => void,
): Promise<void> {
  for (const gate of gates) {
    const result = await gate.validate(response);
    if (!result.valid) {
      const errors = result.errors ?? [];
      onGateFail?.(gate, errors);
      throw KoiRuntimeError.from(
        "VALIDATION",
        `Gate "${gate.name}" rejected the response: ${errors.map((e) => e.message).join("; ")}`,
      );
    }
  }
}
