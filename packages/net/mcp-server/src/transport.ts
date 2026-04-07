/**
 * Transport factory for MCP server.
 *
 * Stdio only — HTTP/SSE transports deferred until per-connection
 * authentication and identity resolution are designed.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// ---------------------------------------------------------------------------
// Stdio transport
// ---------------------------------------------------------------------------

/**
 * Create a stdio-based MCP server transport.
 *
 * Reads JSON-RPC messages from stdin and writes responses to stdout.
 * Suitable for subprocess-based integrations (containers, IDE, CLI).
 */
export function createStdioServerTransport(): StdioServerTransport {
  return new StdioServerTransport();
}
