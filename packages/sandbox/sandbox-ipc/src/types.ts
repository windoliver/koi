export type JsonPrimitive = boolean | number | string | null;

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type SandboxIpcErrorCode = "TIMEOUT" | "OOM" | "PERMISSION" | "CRASH";

export interface ReadyMessage {
  readonly kind: "ready";
}

export interface ExecuteMessage {
  readonly kind: "execute";
  readonly code: string;
  readonly input: JsonValue;
  readonly timeoutMs: number;
}

export interface ResultMessage {
  readonly kind: "result";
  readonly output?: unknown;
  readonly durationMs: number;
  readonly memoryUsedBytes?: number;
}

export interface ErrorMessage {
  readonly kind: "error";
  readonly code: SandboxIpcErrorCode;
  readonly message: string;
  readonly durationMs: number;
}

export type HostMessage = ExecuteMessage;

export type WorkerMessage = ReadyMessage | ResultMessage | ErrorMessage;

export type SandboxIpcMessage = HostMessage | WorkerMessage;

export type ParseSuccess<T> = {
  readonly ok: true;
  readonly value: T;
};

export type ParseFailure = {
  readonly ok: false;
  readonly error: Error;
};

export type ParseResult<T> = ParseSuccess<T> | ParseFailure;
