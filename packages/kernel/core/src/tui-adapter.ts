/**
 * TUI adapter contract — optional rich terminal UI attachment.
 *
 * Implemented by @koi/tui; the null case (no TUI) is the raw-stdout fallback.
 * `@koi/harness` holds a `TuiAdapter | null` — both branches must be tested.
 *
 * Minimal surface: two methods. Harness calls `attach` once per session start
 * and `detach` once on shutdown or Ctrl+C. The TUI consumes the event stream
 * independently; the harness never waits on TUI rendering.
 */

import type { EngineEvent } from "./engine.js";

export interface TuiAdapter {
  /**
   * Start rendering. Called once when the harness begins an agent turn.
   * The TUI subscribes to the iterable and renders events as they arrive.
   * Must not throw — errors are swallowed and the harness falls back to raw stdout.
   */
  readonly attach: (events: AsyncIterable<EngineEvent>) => void;

  /**
   * Stop rendering and clean up terminal state. Called on graceful shutdown,
   * Ctrl+C, or when the session ends. Safe to call after `attach` has already
   * returned (e.g., the iterable was exhausted before detach is called).
   */
  readonly detach: () => void;
}
