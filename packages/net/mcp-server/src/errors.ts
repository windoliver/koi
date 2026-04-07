/**
 * Error sanitization for MCP system boundary.
 *
 * Prevents internal details (agent IDs, stack traces, paths) from
 * leaking to external MCP clients via error messages.
 */

// ---------------------------------------------------------------------------
// Redaction patterns
// ---------------------------------------------------------------------------

/** Patterns that indicate internal details in error messages. */
const REDACT_PATTERNS: readonly RegExp[] = [
  /\/[^\s:]+\.[a-z]{1,4}/gi, // filesystem paths (/foo/bar.ts)
  /agent[- ]?[a-zA-Z0-9_-]{4,}/gi, // agent identifiers
  /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, // UUIDs
  /(?:sk|pk|key|token|secret)[_-]?[a-zA-Z0-9]{8,}/gi, // API keys/tokens
];

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

/** Strip internal details from error messages before returning to MCP clients. */
export function sanitizeMcpError(toolName: string, err: unknown): string {
  if (err instanceof Error) {
    // Strip stack traces (everything after first newline)
    const firstLine = err.message.replace(/\n.*$/s, "").slice(0, 200);
    // Redact internal details from the first line
    const redacted = redactInternal(firstLine);
    return `Tool "${toolName}" failed: ${redacted}`;
  }
  return `Tool "${toolName}" failed: unexpected error`;
}

/** Replace internal details with [redacted] placeholders. */
function redactInternal(message: string): string {
  let result = message;
  for (const pattern of REDACT_PATTERNS) {
    result = result.replace(pattern, "[redacted]");
  }
  return result;
}
