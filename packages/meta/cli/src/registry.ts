/**
 * Command dispatch registry.
 *
 * Maps every KnownCommand to a lazy dynamic import() loader.
 * bin.ts awaits the loader for the dispatched command only — all other command
 * modules are never loaded, keeping startup fast.
 *
 * Registry exhaustiveness is enforced by the Readonly<Record<KnownCommand, ...>>
 * type: missing or extra keys are compile-time errors.
 *
 * Rule: use import() uniformly for all command modules (same-package or cross-package).
 * This is a consistent, teachable single rule — no per-import classification needed.
 */

import type { KnownCommand } from "./args.js";
import type { CommandModule } from "./types.js";

export const COMMAND_LOADERS: Readonly<Record<KnownCommand, () => Promise<CommandModule>>> = {
  init: () => import("./commands/init.js"),
  start: () => import("./commands/start.js"),
  serve: () => import("./commands/serve.js"),
  tui: () => import("./commands/tui.js"),
  sessions: () => import("./commands/sessions.js"),
  logs: () => import("./commands/logs.js"),
  status: () => import("./commands/status.js"),
  doctor: () => import("./commands/doctor.js"),
  stop: () => import("./commands/stop.js"),
  deploy: () => import("./commands/deploy.js"),
};
