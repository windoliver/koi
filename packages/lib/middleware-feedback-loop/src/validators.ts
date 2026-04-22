import type { ModelResponse } from "@koi/core/middleware";
import type { ValidationError, Validator } from "./types.js";

export async function runValidators(
  validators: readonly Validator[],
  response: ModelResponse,
): Promise<readonly ValidationError[]> {
  if (validators.length === 0) return [];
  const results = await Promise.all(validators.map((v) => v.validate(response)));
  return results.flatMap((r) => (r.valid ? [] : (r.errors ?? [])));
}
