/**
 * @koi/middleware-turn-ack — Two-stage acknowledgement for long-running agent turns (Layer 2)
 *
 * Sends "processing" status after a configurable debounce delay,
 * and "idle" status when the turn completes.
 * Depends on @koi/core only.
 */

export type { TurnAckConfig } from "./config.js";
export { validateTurnAckConfig } from "./config.js";
export { createTurnAckMiddleware } from "./turn-ack.js";
