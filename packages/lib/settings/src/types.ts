/**
 * Core types for the @koi/settings cascade loader.
 *
 * HookCommand shape mirrors @koi/hooks HookEventKind — keep in sync.
 */

/** Ordered layers in the settings cascade (lowest to highest priority). */
export type SettingsLayer = "user" | "project" | "local" | "flag" | "policy";

/** Validation error from a single settings file. */
export interface ValidationError {
  /** Absolute path of the file that produced the error. */
  readonly file: string;
  /** Dot-separated JSON path of the offending field (e.g. "permissions.allow[0]"). */
  readonly path: string;
  /** Human-readable description of what is wrong. */
  readonly message: string;
}

/**
 * A single hook command entry.
 * Mirrors CommandHookConfig in @koi/hooks — keep these two in sync.
 */
export interface HookCommand {
  readonly type: "command";
  readonly command: string;
  readonly timeoutMs?: number | undefined;
}

/** Supported hook event names that may appear in settings. */
export type HookEventName = "PreToolUse" | "PostToolUse" | "SessionStart" | "SessionEnd" | "Stop";

/** The JSON shape of a single settings file. All fields optional. */
export interface KoiSettings {
  readonly $schema?: string | undefined;
  readonly permissions?:
    | {
        readonly defaultMode?: "default" | "bypass" | "plan" | "auto" | undefined;
        /** Patterns like "Read(*)", "Bash(git *)", "*" — allow these tools. */
        readonly allow?: readonly string[] | undefined;
        /** Patterns — present approval prompt for these tools. */
        readonly ask?: readonly string[] | undefined;
        /** Patterns — block these tools unconditionally. */
        readonly deny?: readonly string[] | undefined;
        readonly additionalDirectories?: readonly string[] | undefined;
      }
    | undefined;
  /** Environment variables injected into the agent process. */
  readonly env?: Readonly<Record<string, string>> | undefined;
  /** Hooks to run on lifecycle events. */
  readonly hooks?:
    | {
        readonly [K in HookEventName]?: readonly HookCommand[] | undefined;
      }
    | undefined;
  /** Override the model API base URL. */
  readonly apiBaseUrl?: string | undefined;
  /** UI theme preference. */
  readonly theme?: "dark" | "light" | "system" | undefined;
  readonly enableAllProjectMcpServers?: boolean | undefined;
  readonly disabledMcpServers?: readonly string[] | undefined;
}

/** Options passed to `loadSettings()`. */
export interface SettingsLoadOptions {
  /** Project root directory. Defaults to `process.cwd()`. */
  readonly cwd?: string | undefined;
  /** User home directory. Defaults to `os.homedir()`. */
  readonly homeDir?: string | undefined;
  /** Explicit path from `--settings <path>` CLI flag. */
  readonly flagPath?: string | undefined;
  /**
   * Subset of layers to load. Defaults to all 5.
   * Useful in tests (skip policy) or subagents (skip user).
   */
  readonly layers?: readonly SettingsLayer[] | undefined;
  /**
   * Override the platform policy path. Used in tests to supply a custom
   * policy file without root access to /etc/koi/ or /Library/...
   *
   * @internal Do not pass user-controlled or untrusted values here.
   * Production callers must never receive this from user input.
   */
  readonly policyPath?: string | undefined;
}

/** Result returned by `loadSettings()`. */
export interface SettingsLoadResult {
  /** Fully merged settings across all loaded layers. */
  readonly settings: KoiSettings;
  /** Validation errors collected from non-policy layers (never throws on these). */
  readonly errors: readonly ValidationError[];
  /** Per-layer snapshots before merging. `null` = file missing or skipped. */
  readonly sources: Readonly<Record<SettingsLayer, KoiSettings | null>>;
}
