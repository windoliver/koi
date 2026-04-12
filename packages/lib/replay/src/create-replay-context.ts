import type { EngineAdapter } from "@koi/core";
import { createReplayAdapter } from "./create-replay-adapter.js";
import { loadCassette } from "./load-cassette.js";
import type { Cassette } from "./types.js";

/**
 * Context returned by createReplayContext — explicit, composable, debuggable.
 * Use adapter as your EngineAdapter; inspect cassette for assertions.
 *
 * Prefer this over a `replayCassette(path, fn)` wrapper: the caller controls
 * the lifecycle and can assert on cassette fields before or after running.
 *
 * Example:
 *   const { adapter, cassette } = await createReplayContext(path);
 *   expect(cassette.model).toBe("google/gemini-2.0-flash-001");
 *   const koi = createKoi({ adapter, ... });
 */
export interface ReplayContext {
  readonly adapter: EngineAdapter;
  readonly cassette: Cassette;
}

/**
 * Loads a cassette and creates a replay adapter for it.
 * The adapter is stateless: each stream() call replays from chunk 0.
 */
export async function createReplayContext(
  cassettePath: string,
  timeoutMs?: number,
): Promise<ReplayContext> {
  const cassette = await loadCassette(cassettePath);
  const adapter = createReplayAdapter(cassette.chunks, timeoutMs);
  return { adapter, cassette };
}
