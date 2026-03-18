/**
 * CLI channel adapter — stdin/stdout I/O for interactive terminal sessions.
 *
 * Implements the ChannelAdapter contract from @koi/core for local CLI use.
 * Reads user input via readline on stdin, writes agent output to stdout.
 *
 * Built on @koi/channel-base/createChannelAdapter() for all shared channel
 * behavior (lifecycle, handler dispatch, capability-aware rendering, etc.).
 *
 * Slash commands: When `commandDeps` is provided, lines starting with "/"
 * are intercepted and dispatched to @koi/cli-commands instead of being
 * forwarded as agent messages.
 *
 * Rendering note: image, file, and button blocks are downgraded to text
 * by renderBlocks() (since CLI declares these capabilities false) and written
 * to stdout. CustomBlock has no capability flag and passes through to stderr.
 */

import * as readline from "node:readline";
import { createChannelAdapter } from "@koi/channel-base";
import type { CliCommandDeps, CompletionCache } from "@koi/cli-commands";
import {
  createCompletionCache,
  handleSlashCommand,
  refreshCache,
  slashCompleter,
} from "@koi/cli-commands";
import { createColors } from "@koi/cli-render";
import type { ChannelAdapter, ChannelCapabilities } from "@koi/core";

/** Color mode for CLI output. */
export type CliColorMode = "auto" | "always" | "never";

/**
 * Configuration for the CLI channel adapter.
 */
export interface CliChannelConfig {
  /** Readable stream for user input. Defaults to `process.stdin`. */
  readonly input?: NodeJS.ReadableStream;
  /** Writable stream for agent output. Defaults to `process.stdout`. */
  readonly output?: NodeJS.WritableStream;
  /** Writable stream for status/error messages. Defaults to `process.stderr`. */
  readonly errorOutput?: NodeJS.WritableStream;
  /** Prompt string shown before user input. Defaults to `"> "`. */
  readonly prompt?: string;
  /** Sender ID for inbound messages. Defaults to `"cli-user"`. */
  readonly senderId?: string;
  /** Color mode for command output. Defaults to `"auto"`. */
  readonly colorMode?: CliColorMode;
  /**
   * Dependencies for slash command execution.
   * When provided, lines starting with "/" are intercepted as commands.
   * When undefined, all input is forwarded as messages (no slash commands).
   */
  readonly commandDeps?: CliCommandDeps;
}

const CLI_CAPABILITIES = {
  text: true,
  images: false,
  files: false,
  buttons: false,
  audio: false,
  video: false,
  threads: false,
  supportsA2ui: false,
} as const satisfies ChannelCapabilities;

/** Resolve color enabled state from color mode. */
function resolveColorEnabled(mode: CliColorMode, stream: NodeJS.WritableStream): boolean {
  if (mode === "always") return true;
  if (mode === "never") return false;
  // "auto" — detect from stream
  const ws = stream as NodeJS.WriteStream;
  return ws.isTTY === true;
}

/**
 * Creates a CLI channel adapter that reads from stdin and writes to stdout.
 *
 * @param config - Optional configuration overrides.
 * @returns A ChannelAdapter for CLI interaction.
 */
export function createCliChannel(config?: CliChannelConfig): ChannelAdapter {
  const input = config?.input ?? process.stdin;
  const output = config?.output ?? process.stdout;
  const errorOutput = config?.errorOutput ?? process.stderr;
  const prompt = config?.prompt ?? "> ";
  const senderId = config?.senderId ?? "cli-user";
  const colorMode = config?.colorMode ?? "auto";
  const commandDeps = config?.commandDeps;

  // Detect color once at creation time (Issue #14 — no per-write detection)
  const colorEnabled = resolveColorEnabled(colorMode, output);
  const colors = createColors(colorEnabled);

  // Completion cache — refreshed in background, read synchronously by completer
  const completionCache: CompletionCache = createCompletionCache();

  // Seed the cache if command deps are available
  if (commandDeps !== undefined) {
    refreshCache(completionCache, commandDeps);
  }

  // let requires justification: readline interface created/destroyed by platform lifecycle
  let rl: readline.Interface | undefined;

  return createChannelAdapter<string>({
    name: "cli",
    capabilities: CLI_CAPABILITIES,

    platformConnect: async () => {
      const rlOptions: readline.ReadLineOptions = {
        input: input as NodeJS.ReadableStream,
        output: output as NodeJS.WritableStream,
        prompt,
      };

      // Add sync completer when command deps are available
      if (commandDeps !== undefined) {
        rlOptions.completer = (line: string): readonly [readonly string[], string] => {
          return slashCompleter(line, completionCache, commandDeps);
        };
      }

      rl = readline.createInterface(rlOptions);
      rl.prompt();
    },

    platformDisconnect: async () => {
      rl?.close();
      rl = undefined;
    },

    /**
     * After renderBlocks(), only TextBlock and CustomBlock arrive here.
     * TextBlock (including downgraded image/file/button) goes to stdout.
     * CustomBlock (no capability flag, passes through renderBlocks) goes to stderr.
     */
    platformSend: async (message) => {
      for (const block of message.content) {
        if (block.kind === "text") {
          (output as NodeJS.WritableStream).write(`${block.text}\n`);
        } else if (block.kind === "custom") {
          (errorOutput as NodeJS.WritableStream).write(`[custom: ${block.type}]\n`);
        }
        // image/file/button are downgraded to TextBlock by renderBlocks() — unreachable
      }
    },

    /**
     * Registers the dispatch callback on the readline 'line' event.
     * Called after platformConnect(), so rl is guaranteed to be defined.
     *
     * When commandDeps is provided, lines starting with "/" are intercepted
     * and dispatched as slash commands. All other lines are forwarded as messages.
     */
    onPlatformEvent: (handler) => {
      if (rl === undefined) {
        // Cannot happen: onPlatformEvent is called after platformConnect sets rl.
        return () => {};
      }
      const listener = (line: string): void => {
        const trimmed = line.trim();

        // Slash command interception
        if (commandDeps !== undefined && trimmed.startsWith("/")) {
          handleSlashCommand(trimmed, commandDeps)
            .then((result) => {
              if (!result.ok) {
                (output as NodeJS.WritableStream).write(`${colors.red(result.message)}\n`);
              }
              // Refresh completion cache after each command dispatch
              refreshCache(completionCache, commandDeps);
            })
            .catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              (errorOutput as NodeJS.WritableStream).write(`Command error: ${msg}\n`);
            })
            .finally(() => {
              rl?.prompt();
            });
          return;
        }

        // Regular message — forward to channel handler
        handler(line);
        rl?.prompt();
      };
      rl.on("line", listener);
      return () => {
        rl?.off("line", listener);
      };
    },

    normalize: (line: string) => ({
      content: [{ kind: "text", text: line }],
      senderId,
      timestamp: Date.now(),
    }),

    onHandlerError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      (errorOutput as NodeJS.WritableStream).write(`Channel handler error: ${msg}\n`);
    },
  });
}
