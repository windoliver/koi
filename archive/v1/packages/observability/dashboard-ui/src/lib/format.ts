/**
 * Formatting utilities for the dashboard UI.
 */

/** Format milliseconds as a human-readable duration string. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;

  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;

  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/** Format bytes as a human-readable string (e.g., "1.5 GB"). */
export function formatBytes(mb: number): string {
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** Format a Unix timestamp as a relative time string (e.g., "2m ago"). */
export function formatRelativeTime(timestampMs: number): string {
  const diff = Date.now() - timestampMs;
  if (diff < 0) return "just now";
  return `${formatDuration(diff)} ago`;
}
