/**
 * AcpTransport — shared transport interface for ACP communication.
 *
 * Extracted from @koi/engine-acp so both the client (engine-acp) and
 * server (acp) sides share the same transport abstraction.
 */

import type { RpcMessage } from "./json-rpc-parser.js";

export interface AcpTransport {
  /** Send a raw JSON-RPC message string (must be a single line, no newline). */
  readonly send: (messageJson: string) => void;
  /** Async iterable of parsed inbound messages from the peer. */
  readonly receive: () => AsyncIterable<RpcMessage>;
  /** Close the transport. Subsequent send() calls are no-ops. */
  readonly close: () => void;
}
