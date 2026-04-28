/**
 * WebSocket close-code map for the Koi gateway.
 * Node-specific codes (4013, 4014) are omitted — this is the client-only v2 surface.
 */

export interface CloseCodeEntry {
  readonly label: string;
  readonly retryable: boolean;
}

export const CLOSE_CODES = {
  NORMAL: 1000,
  SERVER_SHUTTING_DOWN: 1001,
  AUTH_TIMEOUT: 4001,
  INVALID_HANDSHAKE: 4002,
  AUTH_FAILED: 4003,
  SESSION_EXPIRED: 4004,
  MAX_CONNECTIONS: 4005,
  BUFFER_LIMIT: 4006,
  SESSION_NOT_FOUND: 4007,
  SESSION_STORE_FAILURE: 4008,
  BACKPRESSURE_TIMEOUT: 4009,
  PROTOCOL_MISMATCH: 4010,
  SESSION_EXPIRED_PROCESSING: 4011,
  ADMIN_CLOSED: 4012,
} as const;

export const CLOSE_CODE_MAP: ReadonlyMap<number, CloseCodeEntry> = new Map([
  [1000, { label: "Normal closure", retryable: false }],
  [1001, { label: "Server shutting down", retryable: true }],
  [4001, { label: "Auth timeout", retryable: false }],
  [4002, { label: "Invalid handshake", retryable: false }],
  [4003, { label: "Auth failed", retryable: false }],
  [4004, { label: "Session expired", retryable: true }],
  [4005, { label: "Max connections exceeded", retryable: true }],
  [4006, { label: "Buffer limit exceeded", retryable: true }],
  [4007, { label: "Session not found", retryable: false }],
  [4008, { label: "Session store failure", retryable: true }],
  [4009, { label: "Backpressure timeout", retryable: true }],
  [4010, { label: "Protocol version mismatch", retryable: false }],
  [4011, { label: "Session expired during processing", retryable: true }],
  [4012, { label: "Administratively closed", retryable: false }],
]);

export function isRetryableClose(code: number): boolean {
  return CLOSE_CODE_MAP.get(code)?.retryable ?? true;
}

export function closeCodeLabel(code: number): string {
  return CLOSE_CODE_MAP.get(code)?.label ?? `Unknown close code ${code}`;
}
