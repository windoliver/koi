/**
 * Shared event rendering for CLI commands.
 *
 * Handles all EngineEvent kinds including nested agent spawn/status events.
 * Text deltas go to stdout (agent responses). Everything else goes to stderr.
 */

import { bold, cyan, dim, green, yellow } from "@koi/cli-render";
import type { EngineEvent } from "@koi/core";

export interface RenderEventOptions {
  readonly verbose: boolean;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
}

export function renderEvent(event: EngineEvent, options: RenderEventOptions): void {
  const out = options.stdout ?? process.stdout;
  const err = options.stderr ?? process.stderr;
  const { verbose } = options;

  switch (event.kind) {
    case "text_delta":
      out.write(event.delta);
      break;
    case "tool_call_start":
      if (verbose) {
        err.write(`\n${dim("[tool]")} ${event.toolName}...\n`);
      }
      break;
    case "tool_call_end":
      if (verbose) {
        err.write(`${dim("[tool]")} done\n`);
      }
      break;
    case "done":
      out.write("\n");
      if (verbose) {
        const m = event.output.metrics;
        err.write(
          dim(
            `[${String(m.turns)} turn(s), ${String(m.totalTokens)} tokens, ${String(m.durationMs)}ms]\n`,
          ),
        );
      }
      break;
    case "agent_spawned":
      // Leading \n prevents injection into middle of streamed text_delta output
      err.write(
        `\n${cyan("\u25B6")} ${bold("spawned")} ${green(event.agentName)}${
          event.parentAgentId !== undefined ? dim(` (parent: ${event.parentAgentId})`) : ""
        }\n`,
      );
      break;
    case "agent_status_changed":
      if (verbose) {
        const arrow =
          event.previousStatus !== undefined
            ? `${event.previousStatus} ${yellow("\u2192")} ${event.status}`
            : event.status;
        err.write(`\n${dim(`  [${event.agentName}] ${arrow}`)}\n`);
      }
      break;
    case "turn_start":
    case "turn_end":
    case "custom":
    case "discovery:miss":
    case "spawn_requested":
    case "tool_call_delta":
      // Internal events — no user-visible output
      break;
  }
}
