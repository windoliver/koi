/**
 * Per-subcommand help text (issue #1729).
 *
 * Each entry is the help block printed by `koi <cmd> --help`. The top-level
 * help text lives in bin.ts's `HELP` constant (so the raw-argv fast-path
 * does not need to load this module). This module is only pulled in when
 * dispatch decides the user asked for subcommand help, which is by
 * definition off the startup-latency hot path.
 *
 * Keep each block in sync with the corresponding parser in args/<cmd>.ts —
 * a CLI test asserts every option listed here appears in the command's
 * parser options, and vice versa.
 */

import type { KnownCommand } from "./args/index.js";

const initHelp = `koi init — Create a new agent

Usage:
  koi init [directory] [options]

Options:
  -y, --yes              Accept defaults; skip interactive prompts
      --name <name>      Agent name
      --template <id>    Starter template
      --model <id>       Default model
      --engine <id>      Engine adapter
  -h, --help             Show this help
`;

const startHelp = `koi start — Start an agent interactively

Usage:
  koi start [manifest] [options]

Options:
      --manifest <path>            Path to koi.yaml (overrides positional)
  -p, --prompt <text>              Run a single prompt non-interactively
      --resume <session-id>        Resume a prior session
  -v, --verbose                    Verbose logging
      --dry-run                    Validate config without executing
      --log-format <text|json>     Output format (env: LOG_FORMAT)
      --no-tui                     Force raw stdout; skip @koi/tui
      --context-window <n>         Max transcript messages per request (default 100)
      --until-pass <arg>           Convergence loop verifier argv; repeatable
      --max-iter <n>               Max loop iterations (default 10)
      --verifier-timeout <ms>      Per-iteration verifier timeout (default 120000)
      --allow-side-effects         Required with --until-pass (trust-boundary opt-in)
      --verifier-inherit-env       Forward parent env to verifier subprocess
  -h, --help                       Show this help
`;

const serveHelp = `koi serve — Run agent headless (HTTP service)

Usage:
  koi serve [manifest] [options]

Options:
      --manifest <path>            Path to koi.yaml (overrides positional)
  -p, --port <n>                   Listen port (1–65535)
  -v, --verbose                    Verbose logging
      --log-format <text|json>     Output format
  -h, --help                       Show this help
`;

const tuiHelp = `koi tui — Interactive terminal console

Usage:
  koi tui [options]

Options:
      --manifest <path>            Path to koi.yaml
      --agent <id>                 Agent id (multi-agent manifests)
      --session <id>               Session id to open
      --resume <id>                Resume a prior session (loads transcript)
      --goal <text>                Inject a goal; repeatable
      --until-pass <arg>           Convergence loop verifier argv; repeatable
      --max-iter <n>               Max loop iterations (default 10)
      --verifier-timeout <ms>      Per-iteration verifier timeout (default 120000)
      --allow-side-effects         Required with --until-pass
      --verifier-inherit-env       Forward parent env to verifier subprocess
  -h, --help                       Show this help
`;

const sessionsHelp = `koi sessions — List chat sessions

Usage:
  koi sessions [list] [options]

Options:
      --manifest <path>  Path to koi.yaml
  -n, --limit <n>        Max sessions to list (default 20)
  -h, --help             Show this help
`;

const logsHelp = `koi logs — View service logs

Usage:
  koi logs [manifest] [options]

Options:
      --manifest <path>  Path to koi.yaml (overrides positional)
  -f, --follow           Follow log output
  -n, --lines <n>        Lines to print (default 50)
  -h, --help             Show this help
`;

const statusHelp = `koi status — Check service status

Usage:
  koi status [manifest] [options]

Options:
      --manifest <path>  Path to koi.yaml (overrides positional)
      --timeout <ms>     Connection timeout in milliseconds
      --json             Emit JSON instead of text
  -h, --help             Show this help
`;

const doctorHelp = `koi doctor — Diagnose service health

Usage:
  koi doctor [manifest] [options]

Options:
      --manifest <path>  Path to koi.yaml (overrides positional)
      --repair           Apply safe auto-repairs
      --json             Emit JSON instead of text
  -h, --help             Show this help
`;

const stopHelp = `koi stop — Stop the running service

Usage:
  koi stop [manifest] [options]

Options:
      --manifest <path>  Path to koi.yaml (overrides positional)
  -h, --help             Show this help
`;

const deployHelp = `koi deploy — Install or uninstall as an OS service

Usage:
  koi deploy [manifest] [options]

Options:
      --manifest <path>  Path to koi.yaml (overrides positional)
      --system           System-wide install (may require privilege)
      --uninstall        Remove the installed service
  -p, --port <n>         Listen port for the installed service (1–65535)
  -h, --help             Show this help
`;

const mcpHelp = `koi mcp — Manage MCP servers

Usage:
  koi mcp <subcommand> [args] [options]

Subcommands:
  list                   List configured MCP servers
  auth <server>          Authenticate against a server
  logout <server>        Remove stored credentials for a server
  debug <server>         Print debug info for a server

Options:
      --json             Emit JSON instead of text
  -h, --help             Show this help
`;

const pluginHelp = `koi plugin — Manage plugins

Usage:
  koi plugin <subcommand> [args] [options]

Subcommands:
  install <path>         Install a plugin from a local path
  remove <name>          Remove an installed plugin
  enable <name>          Enable an installed plugin
  disable <name>         Disable an installed plugin
  update <name> <path>   Update an installed plugin from a path
  list                   List installed plugins

Options:
      --json             Emit JSON instead of text
  -h, --help             Show this help
`;

export const COMMAND_HELP: Readonly<Record<KnownCommand, string>> = {
  init: initHelp,
  start: startHelp,
  serve: serveHelp,
  tui: tuiHelp,
  sessions: sessionsHelp,
  logs: logsHelp,
  status: statusHelp,
  doctor: doctorHelp,
  stop: stopHelp,
  deploy: deployHelp,
  mcp: mcpHelp,
  plugin: pluginHelp,
};
