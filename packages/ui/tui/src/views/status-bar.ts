/**
 * Status bar — single-line header showing connection state + active agent.
 *
 * Renders as: ` KOI ` connection_status ` | ` agent_name ` | ` view_hint
 * Uses pi-tui Text component with chalk styling.
 */

import { Text } from "@mariozechner/pi-tui";
import chalk from "chalk";
import type { ConnectionStatus, TuiView } from "../state/types.js";
import { styleConnectionStatus } from "../theme.js";

/** Data needed to render the status bar. */
export interface StatusBarData {
  readonly connectionStatus: ConnectionStatus;
  readonly agentName: string | undefined;
  readonly view: TuiView;
  readonly agentCount: number;
}

/** View hint for each TUI screen. */
const VIEW_HINTS: Readonly<Record<TuiView, string>> = {
  agents: "↑↓ navigate  Enter select  Ctrl+P commands  q quit",
  console: "Type message  Enter send  Esc back  Ctrl+P commands",
  palette: "↑↓ navigate  Enter select  Esc close",
} as const;

/** Create a status bar component. */
export function createStatusBar(): {
  readonly component: Text;
  readonly update: (data: StatusBarData) => void;
} {
  const text = new Text("", 1, 0);

  function update(data: StatusBarData): void {
    const logo = chalk.bgCyan.black(" KOI ");
    const conn = styleConnectionStatus(data.connectionStatus);
    const agents = chalk.dim(`${String(data.agentCount)} agents`);
    const agent =
      data.agentName !== undefined ? chalk.white(data.agentName) : chalk.dim("no agent");
    const hint = chalk.dim(VIEW_HINTS[data.view]);

    text.setText(`${logo} ${conn} │ ${agents} │ ${agent} │ ${hint}`);
    text.invalidate();
  }

  return { component: text, update };
}
