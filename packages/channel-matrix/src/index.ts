/**
 * @koi/channel-matrix — Matrix channel adapter using matrix-bot-sdk.
 *
 * Creates a ChannelAdapter for Matrix homeservers. Supports auto-join,
 * debouncing, and filtered sync for efficient operation.
 *
 * @example
 * ```typescript
 * import { createMatrixChannel } from "@koi/channel-matrix";
 *
 * const channel = createMatrixChannel({
 *   homeserverUrl: "https://matrix.org",
 *   accessToken: process.env.MATRIX_ACCESS_TOKEN!,
 * });
 * await channel.connect();
 * ```
 */

export type { MatrixChannelConfig, MatrixFeatures } from "./config.js";
export { DEFAULT_MATRIX_DEBOUNCE_MS } from "./config.js";
export { descriptor } from "./descriptor.js";
export { createMatrixChannel } from "./matrix-channel.js";
export type { MatrixRoomEvent } from "./normalize.js";
