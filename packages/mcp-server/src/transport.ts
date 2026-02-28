/**
 * Transport factory helpers for MCP server.
 *
 * Provides factory functions to create MCP SDK transports for common
 * server deployment scenarios.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// ---------------------------------------------------------------------------
// Stdio transport
// ---------------------------------------------------------------------------

/**
 * Create a stdio-based MCP server transport.
 *
 * Reads JSON-RPC messages from stdin and writes responses to stdout.
 * Suitable for tool-host integrations where the MCP server is a subprocess.
 */
export function createStdioServerTransport(): StdioServerTransport {
  return new StdioServerTransport();
}
