/**
 * SSE message encoder — converts data payloads to SSE wire format.
 */

const TEXT_ENCODER = new TextEncoder();

/** Encode a data payload as an SSE frame: "data: {json}\n\n" */
export function encodeSseMessage(data: unknown): Uint8Array {
  const json = JSON.stringify(data);
  return TEXT_ENCODER.encode(`data: ${json}\n\n`);
}

/** Pre-encoded keepalive — reused across all connections to avoid allocation. */
const KEEPALIVE_BYTES = TEXT_ENCODER.encode(":keepalive\n\n");

/** Encode an SSE comment (keepalive): ":keepalive\n\n" */
export function encodeSseKeepalive(): Uint8Array {
  return KEEPALIVE_BYTES;
}

/** Encode an SSE event with an ID field for reconnection. */
export function encodeSseMessageWithId(data: unknown, id: string): Uint8Array {
  const json = JSON.stringify(data);
  return TEXT_ENCODER.encode(`id: ${id}\ndata: ${json}\n\n`);
}
