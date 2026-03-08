import type { KoiError, Result, SandboxAdapter } from "@koi/core";
import type { DaytonaAdapterConfig } from "../cloud-types.js";

export async function createDaytonaAdapterShim(
  config: DaytonaAdapterConfig,
): Promise<Result<SandboxAdapter, KoiError>> {
  try {
    const mod = await import("@koi/sandbox-daytona");
    return mod.createDaytonaAdapter(config);
  } catch (error: unknown) {
    throw new Error("To use the Daytona sandbox, install: bun add @koi/sandbox-daytona", {
      cause: error,
    });
  }
}
