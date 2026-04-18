import { ndjsonSafeStringify } from "./ndjson-safe-stringify.js";

type HeadlessEventBody =
  | { readonly kind: "session_start"; readonly startedAt: string }
  | { readonly kind: "assistant_text"; readonly text: string }
  | { readonly kind: "tool_call"; readonly toolName: string; readonly args: unknown }
  | {
      readonly kind: "tool_result";
      readonly toolName: string;
      readonly ok: boolean;
      readonly result: unknown;
    }
  | {
      readonly kind: "result";
      readonly ok: boolean;
      readonly exitCode: number;
      readonly error?: string;
    };

interface EmitterOptions {
  readonly sessionId: string;
  readonly write: (chunk: string) => void;
}

type Emit = (event: HeadlessEventBody) => void;

export function createEmitter(opts: EmitterOptions): Emit {
  return (event) => {
    const payload = { ...event, sessionId: opts.sessionId };
    opts.write(`${ndjsonSafeStringify(payload)}\n`);
  };
}
