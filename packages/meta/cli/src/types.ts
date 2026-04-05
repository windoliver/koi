/**
 * Shared CLI types: CommandModule, ExitCode, JsonOutput, DiagnosticCheck.
 *
 * DiagnosticCheck lives here (not in @koi/core) because it is a CLI-specific
 * concept — health checks for `koi doctor`. @koi/core's DiagnosticProvider is
 * for code analysis (LSP), a separate concern.
 */

import type { CliFlags } from "./args.js";

// ---------------------------------------------------------------------------
// Exit codes — three-tier: OK / WARNING / FAILURE
// Shared across all commands. bin.ts passes the returned value to process.exit().
// ---------------------------------------------------------------------------

export const ExitCode: {
  readonly OK: 0;
  readonly WARNING: 1;
  readonly FAILURE: 2;
} = {
  OK: 0,
  WARNING: 1,
  FAILURE: 2,
} as const;

export type ExitCode = 0 | 1 | 2;

// ---------------------------------------------------------------------------
// CommandModule — every command file must satisfy this interface.
// registry.ts uses Readonly<Record<KnownCommand, () => Promise<CommandModule>>>
// to enforce exhaustiveness over all 10 commands at compile time.
// ---------------------------------------------------------------------------

export interface CommandModule {
  readonly run: (flags: CliFlags) => Promise<ExitCode>;
}

// ---------------------------------------------------------------------------
// JsonOutput — shared envelope for --json output across all commands.
// Commands with a --json flag must write JSON.stringify(result) to stdout
// and exit with the corresponding ExitCode.
// ---------------------------------------------------------------------------

export interface JsonOutput<T> {
  readonly ok: boolean;
  readonly data: T;
  readonly warnings?: readonly string[];
}

// ---------------------------------------------------------------------------
// DiagnosticCheck — a single check emitted by `koi doctor`.
// Each check runner is () => Promise<DiagnosticCheck> (stateless, parallel-safe).
// ---------------------------------------------------------------------------

export type CheckStatus = "pass" | "warn" | "fail";

export interface DiagnosticCheck {
  readonly id: string;
  readonly name: string;
  readonly status: CheckStatus;
  readonly message: string;
  readonly fix?: string;
}
