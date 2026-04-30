import type { KoiError } from "@koi/core";
import type { DockerExecResult } from "./types.js";

export function classifyDockerExit(result: DockerExecResult): KoiError | undefined {
  if (result.exitCode === 0) return undefined;
  if (result.exitCode === 124) {
    return {
      code: "TIMEOUT",
      message: "Docker exec timed out",
      retryable: false,
      context: { exitCode: result.exitCode, stderr: result.stderr.slice(0, 512) },
    };
  }
  const oomKilled = result.exitCode === 137;
  return {
    code: "INTERNAL",
    message: `Docker exec failed with exit code ${result.exitCode}`,
    retryable: false,
    context: {
      exitCode: result.exitCode,
      oomKilled,
      stderr: result.stderr.slice(0, 512),
    },
  };
}
