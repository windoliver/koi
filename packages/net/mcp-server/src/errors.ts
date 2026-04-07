/**
 * Error sanitization for MCP system boundary.
 *
 * Prevents internal details (agent IDs, stack traces, paths) from
 * leaking to external MCP clients via error messages.
 */

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

/** Strip internal details from error messages before returning to MCP clients. */
export function sanitizeMcpError(toolName: string, err: unknown): string {
  if (err instanceof Error) {
    // Strip stack traces and internal paths
    const message = err.message.replace(/\n.*$/s, "").slice(0, 200);
    return `Tool "${toolName}" failed: ${message}`;
  }
  return `Tool "${toolName}" failed: unexpected error`;
}
