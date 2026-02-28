/**
 * AcpTransport — thin abstraction over the ACP process I/O (decision 2A).
 *
 * The transport handles:
 * - Writing JSON-RPC messages to the agent's stdin (one JSON line per message)
 * - Reading JSON-RPC messages from the agent's stdout (line-framed)
 *
 * The transport is intentionally thin — it only handles byte framing.
 * JSON-RPC routing happens in json-rpc-parser.ts.
 */

import type { RpcMessage } from "./json-rpc-parser.js";
import { createLineParser } from "./json-rpc-parser.js";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface AcpTransport {
  /** Send a raw JSON-RPC message string (must be a single line, no newline). */
  readonly send: (messageJson: string) => void;
  /** Async iterable of parsed inbound messages from the agent. */
  readonly receive: () => AsyncIterable<RpcMessage>;
  /** Close the transport. Subsequent send() calls are no-ops. */
  readonly close: () => void;
}

// ---------------------------------------------------------------------------
// Managed process abstraction (mirrors engine-external's ManagedProcess)
// ---------------------------------------------------------------------------

export interface AcpProcess {
  readonly pid: number;
  readonly stdin: {
    write(data: string | Uint8Array): number | Promise<number>;
    end(): void;
  };
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  readonly kill: (signal?: number) => void;
}

// ---------------------------------------------------------------------------
// Stdio transport factory
// ---------------------------------------------------------------------------

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/**
 * Create an AcpTransport backed by a spawned process's stdin/stdout.
 *
 * Messages are framed as newline-delimited JSON lines.
 * The caller owns the process lifecycle — close() only stops writing.
 */
export function createStdioTransport(proc: AcpProcess): AcpTransport {
  // let: lifecycle flag — toggled by close()
  let closed = false;

  function send(messageJson: string): void {
    if (closed) return;
    const line = `${messageJson}\n`;
    // Bun.spawn stdin.write is synchronous in practice; ignore promise
    void proc.stdin.write(TEXT_ENCODER.encode(line));
  }

  function close(): void {
    closed = true;
  }

  function receive(): AsyncIterable<RpcMessage> {
    const parser = createLineParser();

    return {
      [Symbol.asyncIterator](): AsyncIterator<RpcMessage> {
        // let: pending items buffer
        const buffer: RpcMessage[] = [];
        // let: pending consumer resolver (one at a time)
        let resolver: ((result: IteratorResult<RpcMessage, undefined>) => void) | undefined;
        // let: done flag
        let done = false;

        // Start reading stdout in the background
        const reader = proc.stdout.getReader();

        async function read(): Promise<void> {
          try {
            while (true) {
              const { done: streamDone, value } = await reader.read();
              if (streamDone) break;
              const text = TEXT_DECODER.decode(value, { stream: true });
              const messages = parser.feed(text);
              for (const msg of messages) {
                if (resolver !== undefined) {
                  const r = resolver;
                  resolver = undefined;
                  r({ done: false, value: msg });
                } else {
                  buffer.push(msg);
                }
              }
            }
            // Flush partial line
            const flushed = parser.flush();
            for (const msg of flushed) {
              if (resolver !== undefined) {
                const r = resolver;
                resolver = undefined;
                r({ done: false, value: msg });
              } else {
                buffer.push(msg);
              }
            }
          } catch {
            // stdout read error (process crashed) — treat as end of stream
          } finally {
            reader.releaseLock();
            done = true;
            if (resolver !== undefined) {
              const r = resolver;
              resolver = undefined;
              r({ done: true, value: undefined });
            }
          }
        }

        void read();

        return {
          async next(): Promise<IteratorResult<RpcMessage, undefined>> {
            if (buffer.length > 0) {
              const msg = buffer.shift() as RpcMessage;
              return { done: false, value: msg };
            }
            if (done) {
              return { done: true, value: undefined };
            }
            return new Promise<IteratorResult<RpcMessage, undefined>>((resolve) => {
              resolver = resolve;
            });
          },
        };
      },
    };
  }

  return { send, receive, close };
}
