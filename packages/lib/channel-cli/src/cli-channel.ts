/**
 * CLI channel adapter — stdin/stdout I/O for interactive terminal sessions.
 *
 * Implements the ChannelAdapter contract from @koi/core for local CLI use.
 * Reads user input via readline on stdin, writes agent output to stdout.
 *
 * Built on @koi/channel-base/createChannelAdapter() for all shared channel
 * behavior (lifecycle, handler dispatch, capability-aware rendering, etc.).
 *
 * Slash commands: When `commandHandler` is provided, lines starting with "/"
 * are intercepted and dispatched instead of being forwarded as agent messages.
 */

import * as readline from "node:readline";
import { createChannelAdapter } from "@koi/channel-base";
import type { ChannelAdapter, ChannelCapabilities } from "@koi/core";

/** Named theme presets for CLI output styling. */
export type CliTheme = "default" | "mono" | "dark" | "light";

/** Result of a slash command dispatch. */
export interface SlashCommandResult {
  readonly ok: boolean;
  readonly message?: string;
}

/** Async handler for slash command lines. */
export type SlashCommandHandler = (line: string) => Promise<SlashCommandResult>;

/** Completer function for tab completion of slash commands. */
export type SlashCompleter = (line: string) => readonly [readonly string[], string];

/** Resolved theme settings derived from a CliTheme preset. */
interface ResolvedTheme {
  readonly prompt: string;
}

/** Check if a stream is a TTY (for auto color detection). */
function detectTTY(stream: NodeJS.WritableStream): boolean {
  return (stream as NodeJS.WriteStream).isTTY === true;
}

/** Map theme presets to resolved settings. */
function resolveTheme(
  theme: CliTheme | string,
  stream: NodeJS.WritableStream,
  promptOverride?: string,
): ResolvedTheme {
  const isTTY = detectTTY(stream);
  switch (theme) {
    case "mono":
      return { prompt: promptOverride ?? "> " };
    case "dark":
      return { prompt: promptOverride ?? (isTTY ? "\x1b[36mkoi>\x1b[0m " : "koi> ") };
    case "light":
      return { prompt: promptOverride ?? (isTTY ? "\x1b[34mkoi>\x1b[0m " : "koi> ") };
    default:
      return { prompt: promptOverride ?? "> " };
  }
}

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
  /** Prompt string shown before user input. Overrides theme default. */
  readonly prompt?: string;
  /** Sender ID for inbound messages. Defaults to `"cli-user"`. */
  readonly senderId?: string;
  /**
   * Theme preset for CLI styling. Controls prompt appearance.
   * - `"default"` — plain prompt `"> "`
   * - `"mono"` — no ANSI colors, plain prompt
   * - `"dark"` — cyan "koi>" prompt (when TTY)
   * - `"light"` — blue "koi>" prompt (when TTY)
   * Defaults to `"default"`.
   */
  readonly theme?: CliTheme | string;
  /** Async handler for slash command dispatch. When provided, "/" lines are intercepted. */
  readonly commandHandler?: SlashCommandHandler;
  /** Sync completer for tab completion. Used with readline's native completer. */
  readonly completer?: SlashCompleter;
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
  const senderId = config?.senderId ?? "cli-user";
  const commandHandler = config?.commandHandler;
  const completer = config?.completer;

  const theme = resolveTheme(config?.theme ?? "default", output, config?.prompt);
  const prompt = theme.prompt;

  /** Write to a stream, waiting for drain if backpressured. */
  function writeWithDrain(stream: NodeJS.WritableStream, data: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const canContinue = stream.write(data, (err) => {
        if (err !== undefined && err !== null) {
          reject(err);
        }
      });
      if (canContinue) {
        resolve();
      } else {
        stream.once("drain", resolve);
      }
    });
  }

  // let requires justification: readline interface created/destroyed by platform lifecycle
  let rl: readline.Interface | undefined;
  // let requires justification: set after adapter creation so SIGINT handler can call disconnect()
  let adapter: ChannelAdapter | undefined;

  const result = createChannelAdapter<string>({
    name: "cli",
    capabilities: CLI_CAPABILITIES,

    platformConnect: async () => {
      const rlOptions: readline.ReadLineOptions = {
        input: input as NodeJS.ReadableStream,
        output: output as NodeJS.WritableStream,
        prompt,
      };

      if (completer !== undefined) {
        rlOptions.completer = (line: string): readonly [readonly string[], string] => {
          return completer(line);
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
          await writeWithDrain(output as NodeJS.WritableStream, `${block.text}\n`);
        } else if (block.kind === "custom") {
          await writeWithDrain(errorOutput as NodeJS.WritableStream, `[custom: ${block.type}]\n`);
        }
      }
    },

    onPlatformEvent: (handler) => {
      if (rl === undefined) {
        return () => {};
      }
      const listener = (line: string): void => {
        const trimmed = line.trim();

        // Slash command interception
        if (commandHandler !== undefined && trimmed.startsWith("/")) {
          commandHandler(trimmed)
            .then((result) => {
              if (!result.ok && result.message !== undefined) {
                (output as NodeJS.WritableStream).write(`${result.message}\n`);
              }
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

      // Handle SIGINT (Ctrl+C) — call adapter.disconnect() to reset both
      // the platform (readline) and the adapter's connected state properly.
      const sigintHandler = (): void => {
        adapter?.disconnect().catch(() => {
          // Best-effort cleanup — swallow errors during signal handling
        });
      };
      rl.on("SIGINT", sigintHandler);

      return () => {
        rl?.off("line", listener);
        rl?.off("SIGINT", sigintHandler);
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

  adapter = result;
  return result;
}
