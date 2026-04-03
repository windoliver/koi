/**
 * SSE parser re-export from @koi/dashboard-types.
 *
 * The canonical SSE parser and stream consumer now live in the shared
 * dashboard-types package. This module re-exports them for backwards
 * compatibility with existing TUI imports.
 */

export type { SSEEvent, SSEStreamOptions } from "@koi/dashboard-types";
export { consumeSSEStream, SSEParser } from "@koi/dashboard-types";
