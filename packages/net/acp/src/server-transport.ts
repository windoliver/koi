/**
 * Server-side AcpTransport backed by the current process's stdin/stdout.
 *
 * Used when Koi is spawned by an IDE (e.g., `koi serve --manifest koi.yaml`).
 * Reads JSON-RPC lines from stdin, writes JSON-RPC lines to stdout.
 */

import type { AcpTransport, RpcMessage } from "@koi/acp-protocol";
import { createLineParser } from "@koi/acp-protocol";

const TEXT_DECODER = new TextDecoder();

/**
 * Create an AcpTransport backed by the current process's stdin/stdout.
 *
 * - Reads from `process.stdin` as a ReadableStream
 * - Writes to `process.stdout` with backpressure awareness
 * - Close stops reading and writing
 */
export function createProcessTransport(): AcpTransport {
  // let: lifecycle flag
  let closed = false;

  function send(messageJson: string): void {
    if (closed) return;
    const line = `${messageJson}\n`;
    // process.stdout.write returns boolean indicating if buffer is full.
    // We don't block here — the caller (acp-channel) handles backpressure.
    process.stdout.write(line);
  }

  function close(): void {
    closed = true;
  }

  function receive(): AsyncIterable<RpcMessage> {
    const parser = createLineParser();

    return {
      [Symbol.asyncIterator](): AsyncIterator<RpcMessage> {
        const buffer: RpcMessage[] = [];
        // let: pending consumer resolver
        let resolver: ((result: IteratorResult<RpcMessage, undefined>) => void) | undefined;
        // let: done flag
        let done = false;

        const stdin = Bun.stdin.stream();
        const reader = stdin.getReader();

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
            // stdin read error — treat as end of stream
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
