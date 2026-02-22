/**
 * CLI argument parser — hand-rolled for a single subcommand.
 * Parses: koi init [directory] [--yes] [--name <v>] [--template <v>] [--model <v>] [--engine <v>]
 */

export interface CliFlags {
  readonly command: string | undefined;
  readonly directory: string | undefined;
  readonly yes: boolean;
  readonly name: string | undefined;
  readonly template: string | undefined;
  readonly model: string | undefined;
  readonly engine: string | undefined;
}

const VALUED_FLAGS = new Set(["--name", "--template", "--model", "--engine"]);

export function parseArgs(argv: readonly string[]): CliFlags {
  let command: string | undefined;
  let directory: string | undefined;
  let yes = false;
  let name: string | undefined;
  let template: string | undefined;
  let model: string | undefined;
  let engine: string | undefined;

  const flagMap: Record<string, (v: string) => void> = {
    "--name": (v: string) => {
      name = v;
    },
    "--template": (v: string) => {
      template = v;
    },
    "--model": (v: string) => {
      model = v;
    },
    "--engine": (v: string) => {
      engine = v;
    },
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i] as string;

    // Handle --flag=value syntax
    const eqIndex = arg.indexOf("=");
    if (eqIndex !== -1) {
      const key = arg.slice(0, eqIndex);
      const value = arg.slice(eqIndex + 1);
      const handler = flagMap[key];
      if (handler) {
        handler(value);
      }
      i++;
      continue;
    }

    // Boolean flags
    if (arg === "--yes" || arg === "-y") {
      yes = true;
      i++;
      continue;
    }

    // Valued flags
    if (VALUED_FLAGS.has(arg)) {
      const handler = flagMap[arg];
      const nextArg = argv[i + 1];
      if (handler && nextArg !== undefined) {
        handler(nextArg);
        i += 2;
      } else {
        i++;
      }
      continue;
    }

    // Skip unknown flags and their values
    if (arg.startsWith("-")) {
      // If next arg doesn't start with -, assume it's a value for this unknown flag
      const nextArg = argv[i + 1];
      if (nextArg !== undefined && !nextArg.startsWith("-")) {
        i += 2;
      } else {
        i++;
      }
      continue;
    }

    // Positional args: first is command, second is directory
    if (command === undefined) {
      command = arg;
    } else if (directory === undefined) {
      directory = arg;
    }
    i++;
  }

  return { command, directory, yes, name, template, model, engine };
}
