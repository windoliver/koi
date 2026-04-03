/**
 * Relative time formatter for TUI event feeds.
 *
 * Converts a Unix-epoch timestamp to a human-readable relative string
 * like "2m ago" or "1h ago".
 */

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * Format a timestamp as a relative time string.
 * @param timestamp - Unix-epoch milliseconds
 * @param now - Current time in milliseconds (defaults to Date.now(), injectable for tests)
 */
export function relativeTime(timestamp: number, now?: number | undefined): string {
  const elapsed = (now ?? Date.now()) - timestamp;

  if (elapsed < 0) return "just now";
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) {
    const minutes = Math.floor(elapsed / MINUTE);
    return `${String(minutes)}m ago`;
  }
  if (elapsed < DAY) {
    const hours = Math.floor(elapsed / HOUR);
    return `${String(hours)}h ago`;
  }
  const days = Math.floor(elapsed / DAY);
  return `${String(days)}d ago`;
}
