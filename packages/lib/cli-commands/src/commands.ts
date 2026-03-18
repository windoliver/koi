/**
 * CLI REPL slash commands — 10 self-contained command definitions.
 *
 * Each command carries its own handler and optional completer.
 * The /help command auto-generates output from this array.
 */

import type { CliCommandDeps, CommandResult, SlashCommand } from "./types.js";

const OK: CommandResult = { ok: true } as const;

function unavailable(feature: string): CommandResult {
  return { ok: false, message: `/${feature} requires --admin mode. Run: koi start --admin` };
}

function write(deps: CliCommandDeps, text: string): void {
  deps.output.write(`${text}\n`);
}

// ─── Individual Commands ────────────────────────────────────────────

const helpCommand: SlashCommand = {
  name: "help",
  description: "Show available commands",
  args: "[command]",
  execute(rawArgs, deps) {
    if (rawArgs !== "") {
      const target = rawArgs.toLowerCase();
      const cmd = CLI_COMMANDS.find((c) => c.name === target || c.aliases?.includes(target));
      if (cmd === undefined) {
        return {
          ok: false,
          message: `Unknown command: ${target}. Type /help for available commands.`,
        };
      }
      const argHint = cmd.args !== undefined ? ` ${cmd.args}` : "";
      const aliasHint =
        cmd.aliases !== undefined && cmd.aliases.length > 0
          ? ` (aliases: ${cmd.aliases.map((a) => `/${a}`).join(", ")})`
          : "";
      write(deps, `/${cmd.name}${argHint} — ${cmd.description}${aliasHint}`);
      return OK;
    }

    write(deps, "Available commands:");
    for (const cmd of CLI_COMMANDS) {
      const argHint = cmd.args !== undefined ? ` ${cmd.args}` : "";
      write(deps, `  /${cmd.name}${argHint}  ${cmd.description}`);
    }
    return OK;
  },
};

const clearCommand: SlashCommand = {
  name: "clear",
  description: "Clear the screen",
  execute(_rawArgs, deps) {
    // ANSI escape: clear screen + move cursor to top-left
    deps.output.write("\x1b[2J\x1b[H");
    return OK;
  },
};

const cancelCommand: SlashCommand = {
  name: "cancel",
  description: "Cancel the current response",
  execute(_rawArgs, deps) {
    deps.cancelStream();
    write(deps, "Stream cancelled.");
    return OK;
  },
};

const quitCommand: SlashCommand = {
  name: "quit",
  aliases: ["exit"],
  description: "Exit the REPL",
  execute(_rawArgs, deps) {
    deps.exit();
    return OK;
  },
};

const modelCommand: SlashCommand = {
  name: "model",
  description: "Show or switch the active model",
  args: "[name]",
  execute(rawArgs, deps) {
    if (rawArgs === "") {
      const current = deps.currentModel();
      const available = deps.listModels();
      write(deps, `Current model: ${current}`);
      if (available.length > 1) {
        write(deps, `Available: ${available.join(", ")}`);
      }
      return OK;
    }
    const name = rawArgs;
    deps.setModel(name);
    write(deps, `Model set to: ${name}`);
    return OK;
  },
  complete(partial, deps) {
    const models = deps.listModels();
    if (partial === "") return models;
    const lower = partial.toLowerCase();
    return models.filter((m) => m.toLowerCase().startsWith(lower));
  },
};

const statusCommand: SlashCommand = {
  name: "status",
  description: "Show agent status",
  async execute(_rawArgs, deps) {
    if (deps.getStatus === undefined) {
      return unavailable("status");
    }
    try {
      const status = await deps.getStatus();
      write(deps, status);
      return OK;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `Status check failed: ${msg}` };
    }
  },
};

const attachCommand: SlashCommand = {
  name: "attach",
  description: "Switch to a different agent",
  args: "<name>",
  async execute(rawArgs, deps) {
    if (deps.listAgents === undefined || deps.attachAgent === undefined) {
      return unavailable("attach");
    }
    try {
      const agents = await deps.listAgents();
      if (rawArgs === "") {
        if (agents.length === 0) {
          write(deps, "No agents available.");
          return OK;
        }
        write(deps, "Available agents:");
        for (const a of agents) {
          write(deps, `  ${a.name} (${a.agentId}) — ${a.state}`);
        }
        write(deps, "Use /attach <name> to connect.");
        return OK;
      }
      const target = rawArgs.toLowerCase();
      const match = agents.find((a) => a.name.toLowerCase() === target);
      if (match === undefined) {
        const names = agents.map((a) => a.name).join(", ");
        return {
          ok: false,
          message: `Agent not found: ${rawArgs}. Available: ${names || "none"}`,
        };
      }
      return await deps.attachAgent(match.name);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `Attach failed: ${msg}` };
    }
  },
  complete(_partial, deps) {
    if (deps.listAgents === undefined) return [];
    // Uses cached data from CompletionCache — sync access
    return [];
  },
};

const sessionsCommand: SlashCommand = {
  name: "sessions",
  description: "List recent sessions",
  async execute(_rawArgs, deps) {
    if (deps.listSessions === undefined) {
      return unavailable("sessions");
    }
    try {
      const sessions = await deps.listSessions();
      if (sessions.length === 0) {
        write(deps, "No recent sessions.");
        return OK;
      }
      write(deps, "Recent sessions:");
      for (const s of sessions) {
        const date = new Date(s.startedAt).toLocaleString();
        write(deps, `  ${s.sessionId} — ${s.agentName} (${date})`);
      }
      return OK;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `Failed to list sessions: ${msg}` };
    }
  },
};

const toolsCommand: SlashCommand = {
  name: "tools",
  description: "List loaded tools",
  execute(_rawArgs, deps) {
    if (deps.listTools === undefined) {
      write(deps, "Tool listing not available.");
      return OK;
    }
    const tools = deps.listTools();
    if (tools.length === 0) {
      write(deps, "No tools loaded.");
      return OK;
    }
    write(deps, `Loaded tools (${String(tools.length)}):`);
    for (const t of tools) {
      write(deps, `  ${t.name}  ${t.description}`);
    }
    return OK;
  },
};

const FORGE_SUBCOMMANDS = ["search", "install", "inspect"] as const;

const forgeCommand: SlashCommand = {
  name: "forge",
  description: "Search, install, or inspect forge tools",
  args: "search <query> | install <id> | inspect <id>",
  async execute(rawArgs, deps) {
    const parts = rawArgs.split(/\s+/);
    const subcommand = parts[0]?.toLowerCase() ?? "";
    const arg = parts.slice(1).join(" ").trim();

    if (
      subcommand === "" ||
      !FORGE_SUBCOMMANDS.includes(subcommand as (typeof FORGE_SUBCOMMANDS)[number])
    ) {
      return {
        ok: false,
        message: `Usage: /forge ${FORGE_SUBCOMMANDS.join(" | ")}. Example: /forge search "csv parser"`,
      };
    }

    if (subcommand === "search") {
      if (deps.forgeSearch === undefined) {
        return { ok: false, message: "Forge is not configured. Add forge settings to koi.yaml." };
      }
      if (arg === "") {
        return { ok: false, message: "Usage: /forge search <query>" };
      }
      try {
        const results = await deps.forgeSearch(arg);
        if (results.length === 0) {
          write(deps, `No results for "${arg}".`);
          return OK;
        }
        write(deps, `Forge results for "${arg}":`);
        for (const r of results) {
          write(deps, `  ${r.id}  ${r.name} (${r.kind}) — ${r.description}`);
        }
        write(deps, "Use /forge install <id> to activate.");
        return OK;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, message: `Forge search failed: ${msg}` };
      }
    }

    if (subcommand === "install") {
      if (deps.forgeInstall === undefined) {
        return { ok: false, message: "Forge is not configured. Add forge settings to koi.yaml." };
      }
      if (arg === "") {
        return { ok: false, message: "Usage: /forge install <id>" };
      }
      try {
        return await deps.forgeInstall(arg);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, message: `Forge install failed: ${msg}` };
      }
    }

    if (subcommand === "inspect") {
      if (deps.forgeInspect === undefined) {
        return { ok: false, message: "Forge is not configured. Add forge settings to koi.yaml." };
      }
      if (arg === "") {
        return { ok: false, message: "Usage: /forge inspect <id>" };
      }
      try {
        const detail = await deps.forgeInspect(arg);
        write(deps, detail);
        return OK;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, message: `Forge inspect failed: ${msg}` };
      }
    }

    return { ok: false, message: `Unknown forge subcommand: ${subcommand}` };
  },
  complete(partial) {
    if (partial === "") return [...FORGE_SUBCOMMANDS];
    const lower = partial.toLowerCase();
    return FORGE_SUBCOMMANDS.filter((s) => s.startsWith(lower));
  },
};

// ─── Command Registry ───────────────────────────────────────────────

/** All CLI REPL slash commands. Order defines /help output order. */
export const CLI_COMMANDS: readonly SlashCommand[] = [
  helpCommand,
  clearCommand,
  cancelCommand,
  quitCommand,
  modelCommand,
  statusCommand,
  attachCommand,
  sessionsCommand,
  toolsCommand,
  forgeCommand,
] as const;
