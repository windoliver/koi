/**
 * Manages the signal-cli subprocess in JSON-RPC mode.
 *
 * Starts signal-cli as a child process, reads JSON events from stdout,
 * and writes JSON-RPC commands to stdin.
 */

import type { SpawnFn } from "./config.js";
import { SIGNAL_SHUTDOWN_TIMEOUT_MS } from "./config.js";

/** Events emitted by signal-cli in JSON-RPC mode. */
export type SignalEvent =
  | {
      readonly kind: "message";
      readonly source: string;
      readonly timestamp: number;
      readonly body: string;
      readonly groupId?: string;
      readonly attachments?: readonly SignalAttachment[];
    }
  | { readonly kind: "receipt"; readonly source: string; readonly timestamp: number }
  | { readonly kind: "typing"; readonly source: string; readonly started: boolean };

/** Signal attachment metadata. */
export interface SignalAttachment {
  readonly contentType: string;
  readonly filename?: string;
  readonly id: string;
}

/** JSON-RPC command sent to signal-cli stdin. */
export interface SignalCommand {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/** Signal subprocess lifecycle handle. */
export interface SignalProcess {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly send: (command: SignalCommand) => Promise<void>;
  readonly onEvent: (handler: (event: SignalEvent) => void) => () => void;
  readonly isRunning: () => boolean;
}

/**
 * Creates a signal-cli subprocess manager.
 *
 * The subprocess runs in JSON-RPC mode, producing one JSON object per line
 * on stdout. Commands are written as JSON-RPC requests to stdin.
 */
export function createSignalProcess(
  account: string,
  signalCliPath: string,
  configPath: string | undefined,
  spawnFn: SpawnFn,
): SignalProcess {
  // let: subprocess reference, null when not running
  let proc: ReturnType<SpawnFn> | undefined;
  // let: event handler for incoming events
  let eventHandler: ((event: SignalEvent) => void) | undefined;
  // let: tracks whether the process is alive
  let running = false;
  // let: reader cancel handle for stdout
  let readerCancel: (() => void) | undefined;

  function parseSignalEvent(json: Record<string, unknown>): SignalEvent | null {
    // signal-cli JSON-RPC wraps events in an "envelope" object
    const envelope = (json.params as Record<string, unknown> | undefined) ?? json;
    const dataMessage = envelope.dataMessage as Record<string, unknown> | undefined;

    if (dataMessage !== undefined && typeof dataMessage.message === "string") {
      return {
        kind: "message",
        source: typeof envelope.source === "string" ? envelope.source : "",
        timestamp: typeof dataMessage.timestamp === "number" ? dataMessage.timestamp : Date.now(),
        body: dataMessage.message,
        ...(typeof dataMessage.groupInfo === "object" && dataMessage.groupInfo !== null
          ? { groupId: (dataMessage.groupInfo as Record<string, unknown>).groupId as string }
          : {}),
      };
    }

    if (envelope.receiptMessage !== undefined) {
      return {
        kind: "receipt",
        source: typeof envelope.source === "string" ? envelope.source : "",
        timestamp: Date.now(),
      };
    }

    if (envelope.typingMessage !== undefined) {
      const typing = envelope.typingMessage as Record<string, unknown>;
      return {
        kind: "typing",
        source: typeof envelope.source === "string" ? envelope.source : "",
        started: typing.action === "STARTED",
      };
    }

    return null;
  }

  async function readStdout(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    // let: line buffer for partial reads
    let buffer = "";

    readerCancel = () => {
      void reader.cancel();
    };

    try {
      while (running) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          try {
            const json = JSON.parse(trimmed) as Record<string, unknown>;
            const event = parseSignalEvent(json);
            if (event !== null) {
              eventHandler?.(event);
            }
          } catch {
            // Skip malformed JSON lines
          }
        }
      }
    } catch {
      // Stream closed or read error — expected on shutdown
    } finally {
      reader.releaseLock();
    }
  }

  return {
    start: async (): Promise<void> => {
      if (running) return;

      const cmd: string[] = [signalCliPath, "-a", account];
      if (configPath !== undefined) {
        cmd.push("--config", configPath);
      }
      cmd.push("jsonRpc");

      proc = spawnFn(cmd);
      running = true;
      void readStdout(proc.stdout);
    },

    stop: async (): Promise<void> => {
      if (!running || proc === undefined) return;
      running = false;
      readerCancel?.();

      proc.kill(15); // SIGTERM
      const exited = await Promise.race([
        proc.exited,
        new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), SIGNAL_SHUTDOWN_TIMEOUT_MS),
        ),
      ]);

      if (exited === "timeout") {
        proc.kill(9); // SIGKILL
      }

      proc = undefined;
    },

    send: async (command: SignalCommand): Promise<void> => {
      if (proc === undefined || !running) {
        throw new Error("[channel-signal] Cannot send command: process not running");
      }
      const rpc = {
        jsonrpc: "2.0",
        method: command.method,
        params: command.params,
        id: Date.now(),
      };
      const encoded = new TextEncoder().encode(`${JSON.stringify(rpc)}\n`);
      proc.stdin.write(encoded);
    },

    onEvent: (handler: (event: SignalEvent) => void): (() => void) => {
      eventHandler = handler;
      return () => {
        eventHandler = undefined;
      };
    },

    isRunning: (): boolean => running,
  };
}
