import type { ExecutionContext, SandboxErrorCode, SandboxExecutor } from "@koi/core";
import { transpileTs } from "./transpile.js";

export type ScriptErrorCode = SandboxErrorCode | "TRANSPILE";

export interface ScriptError {
  readonly code: ScriptErrorCode;
  readonly message: string;
  readonly durationMs: number;
}

export interface ScriptConfig {
  readonly code: string;
  readonly language?: "javascript" | "typescript";
  readonly timeoutMs?: number;
  readonly input?: unknown;
  readonly executor: SandboxExecutor;
  readonly context?: ExecutionContext | undefined;
}

export interface ScriptResult {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly durationMs: number;
  readonly error?: ScriptError;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function wrapAsAsyncBody(jsCode: string): string {
  // Wrap user code so it can use `return` and `await` naturally. The runner
  // sandbox expects a self-contained module that prints/returns its result.
  return `export default async function (input) {\n${jsCode}\n};\n`;
}

export async function executeScript(config: ScriptConfig): Promise<ScriptResult> {
  const start = performance.now();
  const language = config.language ?? "javascript";
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Justified `let`: reassigned after optional transpilation.
  let jsCode = config.code;
  if (language === "typescript") {
    const transpiled = transpileTs(config.code);
    if (!transpiled.ok) {
      return {
        ok: false,
        durationMs: performance.now() - start,
        error: { code: "TRANSPILE", message: transpiled.error, durationMs: 0 },
      };
    }
    jsCode = transpiled.code;
  }

  const wrapped = wrapAsAsyncBody(jsCode);
  const execResult = await config.executor.execute(
    wrapped,
    config.input ?? null,
    timeoutMs,
    config.context,
  );
  const durationMs = performance.now() - start;

  if (!execResult.ok) {
    return {
      ok: false,
      durationMs,
      error: {
        code: execResult.error.code,
        message: execResult.error.message,
        durationMs: execResult.error.durationMs,
      },
    };
  }

  return { ok: true, result: execResult.value.output, durationMs };
}
