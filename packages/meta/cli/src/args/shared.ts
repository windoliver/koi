/**
 * Shared parser infrastructure — used by all per-command arg modules.
 *
 * Exports: ParseError, BaseFlags, typedParseArgs, parseIntFlag,
 * resolveLogFormat, detectGlobalFlags, extractCommand.
 */

import { parseArgs as nodeParseArgs } from "node:util";

// ---------------------------------------------------------------------------
// Parse error
// ---------------------------------------------------------------------------

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

// ---------------------------------------------------------------------------
// Base flag types
// ---------------------------------------------------------------------------

export interface BaseFlags {
  readonly command: string | undefined;
  readonly version: boolean;
  readonly help: boolean;
}

export type GlobalFlags = { readonly version: boolean; readonly help: boolean };

// ---------------------------------------------------------------------------
// Internal types (not exported — only used by per-command parsers)
// ---------------------------------------------------------------------------

type ParseToken =
  | {
      readonly kind: "option";
      readonly name: string;
      readonly rawName: string;
      readonly value: string | undefined;
      readonly inlineValue: boolean | undefined;
    }
  | { readonly kind: "positional"; readonly value: string }
  | { readonly kind: "option-terminator" };

type OptionConfig = {
  readonly type: "string" | "boolean";
  readonly short?: string;
  readonly multiple?: boolean;
  readonly default?: string | boolean;
};

// ---------------------------------------------------------------------------
// Shared parser helpers
// ---------------------------------------------------------------------------

/**
 * Typed wrapper around node:util parseArgs with unknown-flag rejection.
 *
 * Isolates the single justified cast boundary with the external nodeParseArgs
 * API (complex overloads + tokens: true return type). All callers get fully
 * typed values via T with zero scattered casts.
 */
export function typedParseArgs<T extends Record<string, string | boolean | string[] | undefined>>(
  config: {
    readonly args: readonly string[];
    readonly options: Readonly<Record<string, OptionConfig>>;
    readonly allowPositionals?: boolean;
  },
  command: string,
): { readonly values: T; readonly positionals: readonly string[] } {
  const parseResult = nodeParseArgs({
    args: [...config.args],
    options: config.options,
    strict: false,
    allowPositionals: config.allowPositionals ?? false,
    tokens: true,
  } as unknown as Parameters<typeof nodeParseArgs>[0]) as unknown as {
    readonly values: Record<string, string | boolean | string[] | undefined>;
    readonly positionals: readonly string[];
    readonly tokens: ReadonlyArray<ParseToken>;
  };

  // --help and --version are a safety-first escape hatch. If a bare
  // --help/-h/--version/-V token was consumed as the value of a
  // preceding string option (e.g. `koi start --prompt --help`), that
  // usually means the user fat-fingered a missing value — not that
  // they actually want a literal `--help` prompt. Running the command
  // in that state can trigger side effects (model calls, filesystem
  // writes), so we short-circuit: the parsed boolean is forced on,
  // and the consumed option value is cleared. Users who genuinely
  // need a flag-shaped string operand can pass it inline
  // (`--prompt=--help`) or after `--` (`koi start -- --prompt --help`).
  const HELP_TOKENS: ReadonlySet<string> = new Set(["--help", "-h"]);
  const VERSION_TOKENS: ReadonlySet<string> = new Set(["--version", "-V"]);
  const values = parseResult.values as Record<string, string | boolean | string[] | undefined>;
  for (const token of parseResult.tokens) {
    if (token.kind !== "option") continue;
    if (token.inlineValue !== false) continue;
    const v = token.value;
    if (typeof v !== "string") continue;
    if (HELP_TOKENS.has(v)) {
      values.help = true;
      values[token.name] = undefined;
    } else if (VERSION_TOKENS.has(v)) {
      values.version = true;
      values[token.name] = undefined;
    }
  }

  // --help and --version are an escape hatch: when either is set,
  // skip unknown-flag rejection so malformed tails like
  // `koi start --help --typo` still reach the help/version exit path
  // rather than erroring out with "unknown flag --typo".
  const helpOrVersionRequested = values.help === true || values.version === true;

  if (!helpOrVersionRequested) {
    const knownFlags = new Set(Object.keys(config.options));
    for (const token of parseResult.tokens) {
      if (token.kind === "option" && !knownFlags.has(token.name)) {
        throw new ParseError(`unknown flag ${token.rawName} for 'koi ${command}'`);
      }
    }
  }

  return { values: parseResult.values as T, positionals: parseResult.positionals };
}

/**
 * parseIntFlag variant used by the help/version escape hatch: when
 * `skipValidators` is true and the underlying validator would throw,
 * return `fallback` instead. Lets parsers continue to build a
 * shape-complete flags object when the user is only asking for help.
 */
export function parseIntFlagSafe(
  name: string,
  value: string,
  min: number,
  max: number,
  skipValidators: boolean,
  fallback: number,
): number {
  if (skipValidators) {
    try {
      return parseIntFlag(name, value, min, max);
    } catch {
      return fallback;
    }
  }
  return parseIntFlag(name, value, min, max);
}

/**
 * Validates a numeric CLI flag. Rejects non-integers, trailing junk (e.g. "123abc"),
 * scientific notation (e.g. "1e3"), and out-of-range values.
 */
export function parseIntFlag(name: string, value: string, min: number, max: number): number {
  const range = max === Number.MAX_SAFE_INTEGER ? `≥ ${min}` : `${min}–${max}`;
  if (!/^-?\d+$/.test(value)) {
    throw new ParseError(`--${name} must be an integer (${range}), got '${value}'`);
  }
  const n = Number.parseInt(value, 10);
  if (n < min || n > max) {
    throw new ParseError(`--${name} must be an integer (${range}), got '${value}'`);
  }
  return n;
}

/**
 * Resolves log format from flag value or LOG_FORMAT env var.
 * Throws ParseError on invalid values.
 */
export function resolveLogFormat(flagValue: string | undefined): "text" | "json" {
  const raw = flagValue ?? process.env.LOG_FORMAT;
  if (raw === undefined || raw === "text") return "text";
  if (raw === "json") return "json";
  throw new ParseError(`--log-format must be 'text' or 'json', got '${raw}'`);
}

export function detectGlobalFlags(argv: readonly string[]): GlobalFlags {
  // Tokens after `--` are literal operands, not flags: `koi plugin install
  // -- --help` targets a plugin literally named `--help`, not a help
  // request. Stop scanning at the first terminator.
  let version = false;
  let help = false;
  for (const a of argv) {
    if (a === "--") break;
    if (a === "--version" || a === "-V") version = true;
    else if (a === "--help" || a === "-h") help = true;
  }
  return { version, help };
}

export function extractCommand(argv: readonly string[]): {
  readonly command: string | undefined;
  readonly rest: readonly string[];
} {
  const first = argv[0];
  if (first === undefined || first.startsWith("-")) {
    return { command: undefined, rest: argv };
  }
  return { command: first, rest: argv.slice(1) };
}
