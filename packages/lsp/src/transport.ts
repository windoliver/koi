/**
 * Stdio transport for LSP server communication.
 *
 * Spawns an LSP server as a subprocess and provides access to its
 * stdin/stdout streams for JSON-RPC communication.
 */

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { ResolvedLspServerConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LspTransport {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly process: ChildProcess;
  readonly dispose: () => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a stdio transport by spawning the LSP server as a subprocess.
 *
 * Throws if the process cannot be spawned or has no stdin/stdout.
 */
export function createStdioTransport(config: ResolvedLspServerConfig): LspTransport {
  const proc = spawn(config.command, [...config.args], {
    env: { ...process.env, ...config.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (proc.stdin === null || proc.stdout === null) {
    proc.kill();
    throw new Error(`LSP server "${config.name}": failed to open stdio pipes`);
  }

  const dispose = (): void => {
    if (!proc.killed) {
      proc.kill();
    }
  };

  return {
    stdin: proc.stdin,
    stdout: proc.stdout,
    process: proc,
    dispose,
  };
}
