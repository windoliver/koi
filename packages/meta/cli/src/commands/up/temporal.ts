/**
 * Temporal auto-start phase.
 */

import type { TemporalEmbedHandle } from "@koi/temporal";

/**
 * Auto-starts a local Temporal dev server via `@koi/temporal` embed mode.
 * Returns the embed handle (with gRPC URL + dispose) or undefined on failure.
 */
export async function startTemporalEmbed(
  verbose: boolean,
): Promise<TemporalEmbedHandle | undefined> {
  try {
    const { ensureTemporalRunning } = await import("@koi/temporal");
    const handle = await ensureTemporalRunning();
    if (verbose) {
      process.stderr.write(`Temporal: auto-started at ${handle.url} (UI: ${handle.uiUrl})\n`);
    }
    return handle;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`warn: Temporal auto-start failed: ${message}\n`);
    return undefined;
  }
}
