/**
 * Polling-based condition waiter for integration tests.
 *
 * Replaces raw setTimeout delays with deterministic condition checks,
 * reducing flakiness on slow CI environments.
 */

export async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 5_000,
  pollMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`waitForCondition timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
