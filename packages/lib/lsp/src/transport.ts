/**
 * Stdio transport for LSP server communication — Bun-native implementation.
 *
 * Spawns an LSP server as a subprocess using Bun.spawn() and provides
 * access to its stdin/stdout for JSON-RPC communication.
 */

import type { ResolvedLspServerConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LspTransport {
  readonly stdin: import("bun").FileSink;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  readonly dispose: () => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a stdio transport by spawning the LSP server as a subprocess.
 *
 * Uses Bun.spawn() for native stream support. Throws if spawn fails.
 */
export function createStdioTransport(config: ResolvedLspServerConfig): LspTransport {
  const proc = Bun.spawn({
    cmd: [config.command, ...config.args],
    env: { ...process.env, ...config.env } as Record<string, string>,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const dispose = (): void => {
    proc.kill();
  };

  return {
    stdin: proc.stdin,
    stdout: proc.stdout,
    exited: proc.exited,
    dispose,
  };
}
