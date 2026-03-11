/**
 * @koi/dashboard-client — Typed HTTP and SSE clients for the Koi admin API.
 *
 * L0u package: depends on @koi/core, @koi/dashboard-types.
 * Zero UI dependencies — pure HTTP/SSE/parsing logic.
 */

// Client — Admin API
export type {
  AdminClient,
  AdminClientConfig,
  ClientResult,
  DispatchRequest,
  DispatchResponse,
  FsEntry,
} from "./client/admin-client.js";
export { createAdminClient } from "./client/admin-client.js";

// Client — AG-UI Chat
export type {
  AguiClientConfig,
  AguiEvent,
  AguiEventType,
  AguiStreamCallbacks,
  AguiStreamHandle,
  ChatHistoryMessage,
  ChatRunInput,
} from "./client/agui-client.js";
export { startChatStream } from "./client/agui-client.js";

// Client — Reconnection
export type {
  ReconnectCallbacks,
  ReconnectConfig,
  ReconnectHandle,
  ReconnectStatus,
  SSEFetcher,
} from "./client/reconnect.js";
export { createReconnectingStream } from "./client/reconnect.js";

// Client — SSE
export type { SSEEvent, SSEStreamOptions } from "./client/sse-stream.js";
export { consumeSSEStream, SSEParser } from "./client/sse-stream.js";
// Debounce
export type { DebouncedFn } from "./debounce.js";
export { createDebounce } from "./debounce.js";

// Session loading
export { buildSessionPath, loadSavedSession } from "./session-loader.js";
// Types
export type {
  ChatMessage,
  DashboardClientError,
  SessionInfo,
} from "./types.js";
export {
  CHAT_SESSION_PREFIX,
  ENGINE_SESSION_PREFIX,
  parseSessionRecord,
  parseTuiChatLog,
  TUI_SESSION_PREFIX,
} from "./types.js";
