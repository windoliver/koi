/**
 * Constants for Nexus embed mode.
 */

/** Default port for embedded Nexus server. */
export const DEFAULT_PORT = 2026;

/** Default host — localhost only for security. */
export const DEFAULT_HOST = "127.0.0.1";

/** Default deployment profile for embedded Nexus. */
export const DEFAULT_PROFILE = "lite";

/** Default data directory for embed state files. */
export const DEFAULT_DATA_DIR_NAME = ".koi/nexus";

/** Health check polling: initial delay in ms. */
export const HEALTH_INITIAL_DELAY_MS = 100;

/** Health check polling: backoff multiplier. */
export const HEALTH_BACKOFF_MULTIPLIER = 1.5;

/** Health check polling: maximum interval in ms. */
export const HEALTH_MAX_INTERVAL_MS = 1_000;

/** Health check polling: total timeout in ms. */
export const HEALTH_TOTAL_TIMEOUT_MS = 15_000;

/** Health check probe timeout for single request in ms. */
export const HEALTH_PROBE_TIMEOUT_MS = 500;

/** Filename for connection state. */
export const CONNECTION_STATE_FILE = "embed.json";

/** Filename for PID file. */
export const PID_FILE = "nexus.pid";

/** Filename for Nexus runtime state (written by `nexus up` into data_dir). */
export const STATE_JSON_FILE = ".state.json";
