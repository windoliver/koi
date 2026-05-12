import { serialize } from "node:v8";
import type { Result } from "@koi/core";
import { signalNameFromNumber } from "./spawn.js";
import type { BridgeResult, ErrorMessage, IpcError, IpcErrorCode, ResultMessage } from "./types.js";

export function createIpcError(
  code: IpcErrorCode,
  message: string,
  details?: {
    readonly exitCode?: number;
    readonly signal?: string;
    readonly durationMs?: number;
  },
): IpcError {
  return {
    code,
    message,
    ...(details?.exitCode !== undefined ? { exitCode: details.exitCode } : {}),
    ...(details?.signal !== undefined ? { signal: details.signal } : {}),
    ...(details?.durationMs !== undefined ? { durationMs: details.durationMs } : {}),
  };
}

export function classifyExitCode(exitCode: number, durationMs: number): IpcError {
  if (exitCode === 137) {
    return createIpcError("OOM", "Worker killed by SIGKILL (likely OOM)", {
      exitCode,
      signal: "SIGKILL",
      durationMs,
    });
  }
  if (exitCode === 124) {
    return createIpcError("TIMEOUT", "Worker self-terminated due to timeout", {
      exitCode,
      durationMs,
    });
  }
  if (exitCode !== 0) {
    const signal = exitCode > 128 ? signalNameFromNumber(exitCode - 128) : undefined;
    return createIpcError("CRASH", `Worker exited with code ${exitCode}`, {
      exitCode,
      ...(signal !== undefined ? { signal } : {}),
      durationMs,
    });
  }
  return createIpcError("CRASH", "Worker exited cleanly without sending a terminal message", {
    exitCode,
    durationMs,
  });
}

export function mapWorkerErrorCode(code: ErrorMessage["code"]): IpcErrorCode {
  switch (code) {
    case "TIMEOUT":
      return "TIMEOUT";
    case "OOM":
      return "OOM";
    case "PERMISSION":
      return "PERMISSION";
    case "CRASH":
      return "WORKER_ERROR";
  }
}

export function processResultMessage(
  message: ResultMessage,
  maxResultBytes: number,
  spawnDurationMs: number,
  serialization: "advanced" | "json",
): Result<BridgeResult, IpcError> {
  let sizeBytes: number;
  try {
    if (serialization === "advanced") {
      sizeBytes = serialize(message.output).byteLength;
    } else {
      const serialized = JSON.stringify(message.output ?? null);
      sizeBytes = Buffer.byteLength(serialized, "utf8");
    }
  } catch (error) {
    return {
      ok: false,
      error: createIpcError(
        "DESERIALIZE",
        `Result could not be serialized for ${serialization} IPC: ${error instanceof Error ? error.message : String(error)}`,
        { durationMs: message.durationMs },
      ),
    };
  }

  if (sizeBytes > maxResultBytes) {
    return {
      ok: false,
      error: createIpcError(
        "RESULT_TOO_LARGE",
        `Result size ${sizeBytes} bytes exceeds limit of ${maxResultBytes} bytes`,
        { durationMs: message.durationMs },
      ),
    };
  }

  return {
    ok: true,
    value: {
      output: message.output,
      durationMs: message.durationMs,
      ...(message.memoryUsedBytes !== undefined
        ? { memoryUsedBytes: message.memoryUsedBytes }
        : {}),
      exitCode: 0,
      spawnDurationMs,
    },
  };
}
