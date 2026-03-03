/**
 * Default ACP terminal/* method handlers.
 *
 * Koi acts as the "headless IDE" for terminal operations. Uses Bun.spawn()
 * to manage child processes on behalf of the agent.
 */

import type {
  TerminalCreateParams,
  TerminalCreateResult,
  TerminalOutputResult,
  TerminalSessionParams,
  TerminalWaitForExitResult,
} from "@koi/acp-protocol";

// ---------------------------------------------------------------------------
// Terminal registry
// ---------------------------------------------------------------------------

interface ManagedTerminal {
  readonly command: string;
  readonly proc: {
    readonly pid: number;
    readonly exited: Promise<number>;
    readonly kill: (signal?: number) => void;
    readonly stdout: ReadableStream<Uint8Array>;
    readonly stderr: ReadableStream<Uint8Array>;
  };
  // let: accumulated output buffer
  outputBuffer: string;
  // let: whether the output was truncated
  truncated: boolean;
}

export interface TerminalRegistry {
  readonly create: (params: TerminalCreateParams) => Promise<TerminalCreateResult>;
  readonly output: (params: TerminalSessionParams) => Promise<TerminalOutputResult>;
  readonly waitForExit: (params: TerminalSessionParams) => Promise<TerminalWaitForExitResult>;
  readonly kill: (params: TerminalSessionParams) => Promise<null>;
  readonly release: (params: TerminalSessionParams) => Promise<null>;
}

const DEFAULT_OUTPUT_BYTE_LIMIT = 1_048_576 as const; // 1 MiB

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

let terminalCounter = 0;

/**
 * Create a terminal registry that manages spawned subprocesses for a session.
 */
export function createTerminalRegistry(): TerminalRegistry {
  const terminals = new Map<string, ManagedTerminal>();
  const decoder = new TextDecoder();

  async function create(params: TerminalCreateParams): Promise<TerminalCreateResult> {
    const terminalId = `term-${++terminalCounter}`;
    const byteLimit = params.outputByteLimit ?? DEFAULT_OUTPUT_BYTE_LIMIT;

    const envRecord: Record<string, string> = {};
    if (params.env !== undefined) {
      for (const { name, value } of params.env) {
        envRecord[name] = value;
      }
    }

    const proc = Bun.spawn([params.command, ...(params.args ?? [])], {
      ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
      ...(params.env !== undefined ? { env: { ...process.env, ...envRecord } } : {}),
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });

    const terminal: ManagedTerminal = {
      command: params.command,
      proc,
      outputBuffer: "",
      truncated: false,
    };

    terminals.set(terminalId, terminal);

    // Start collecting stdout + stderr into the buffer
    void collectOutput(terminal, proc.stdout, byteLimit);
    void collectOutput(terminal, proc.stderr, byteLimit);

    return { terminalId };
  }

  async function collectOutput(
    terminal: ManagedTerminal,
    stream: ReadableStream<Uint8Array>,
    byteLimit: number,
  ): Promise<void> {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        const newTotal = terminal.outputBuffer.length + text.length;
        if (newTotal > byteLimit) {
          const remaining = byteLimit - terminal.outputBuffer.length;
          if (remaining > 0) {
            terminal.outputBuffer += text.slice(0, remaining);
          }
          terminal.truncated = true;
        } else {
          terminal.outputBuffer += text;
        }
      }
    } catch {
      // Stream read error — output collection stops
    } finally {
      reader.releaseLock();
    }
  }

  async function output(params: TerminalSessionParams): Promise<TerminalOutputResult> {
    const terminal = terminals.get(params.terminalId);
    if (terminal === undefined) {
      throw new Error(`Terminal not found: ${params.terminalId}`);
    }

    // Check if process has exited
    const exitCode = await Promise.race([
      terminal.proc.exited,
      // If still running, resolve with undefined after a brief poll
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 0)),
    ]);

    const exitStatus = typeof exitCode === "number" ? { exitCode, signal: null } : undefined;

    return {
      output: terminal.outputBuffer,
      truncated: terminal.truncated,
      ...(exitStatus !== undefined ? { exitStatus } : {}),
    };
  }

  async function waitForExit(params: TerminalSessionParams): Promise<TerminalWaitForExitResult> {
    const terminal = terminals.get(params.terminalId);
    if (terminal === undefined) {
      throw new Error(`Terminal not found: ${params.terminalId}`);
    }

    const exitCode = await terminal.proc.exited;
    return { exitCode, signal: null };
  }

  async function kill(params: TerminalSessionParams): Promise<null> {
    const terminal = terminals.get(params.terminalId);
    if (terminal === undefined) {
      // Already gone — not an error
      return null;
    }
    terminal.proc.kill();
    return null;
  }

  async function release(params: TerminalSessionParams): Promise<null> {
    const terminal = terminals.get(params.terminalId);
    if (terminal !== undefined) {
      terminal.proc.kill();
      terminals.delete(params.terminalId);
    }
    return null;
  }

  return { create, output, waitForExit, kill, release };
}
