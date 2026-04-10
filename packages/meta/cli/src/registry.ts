/**
 * Command dispatch registry.
 *
 * Maps every KnownCommand to a lazy dynamic import() loader. TypeScript infers
 * the specific type per loader (e.g. `() => Promise<CommandModule<StartFlags>>`),
 * so each command file's `run()` is type-checked against its declared flag type.
 *
 * The `satisfies` check verifies exhaustiveness only — all KnownCommand keys
 * must be present. The actual run() type safety lives in each command file.
 *
 * bin.ts holds the single justified cast at the dispatch boundary:
 *   `(mod as CommandModule).run(flags)` — flags were produced by the
 *   command-specific parser, so the cast is always correct at runtime.
 */

import type { KnownCommand } from "./args.js";

// Explicit type satisfies isolatedDeclarations and enforces exhaustiveness.
// Using Promise<unknown> avoids contravariant run() conflicts — the cast lives
// in bin.ts at the dispatch boundary where flags are already command-specific.
export const COMMAND_LOADERS: Readonly<Record<KnownCommand, () => Promise<unknown>>> = {
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
  mcp: () => import("./commands/mcp.js"),
  plugin: () => import("./commands/plugin.js"),
};
