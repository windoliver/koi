/**
 * TUI command dispatch — maps command IDs to store/API operations.
 *
 * Extracted from tui-app to keep the orchestrator under the 800-line limit.
 */

import type { AdminClient, ClientResult } from "@koi/dashboard-client";
import type { TuiStore } from "../state/store.js";
import type { TuiView } from "../state/types.js";

/** Dependencies injected by tui-app for command execution. */
export interface CommandDeps {
  readonly store: TuiStore;
  readonly client: AdminClient;
  readonly refreshAgents: () => Promise<void>;
  readonly openAgentConsole: (agentId: string) => void;
  readonly openDataSources: () => Promise<void>;
  readonly rescanDataSources: () => Promise<void>;
  readonly approveDataSource: (name: string) => Promise<void>;
  readonly viewDataSourceSchema: (name: string) => Promise<void>;
  readonly openSessionPicker: () => Promise<void>;
  readonly showAgentLogs: () => Promise<void>;
  readonly openInBrowser: () => void;
  readonly cancelActiveStream: () => void;
  readonly stop: () => Promise<void>;
  readonly addLifecycleMessage: (event: string) => void;
}

/** Dispatch a command by ID — returns true if recognized. */
export function dispatchCommand(commandId: string, deps: CommandDeps): boolean {
  switch (commandId) {
    case "refresh":
      deps.refreshAgents().catch(() => {});
      return true;

    case "agents":
      deps.cancelActiveStream();
      deps.store.dispatch({ kind: "set_session", session: null });
      deps.store.dispatch({ kind: "set_view", view: "agents" });
      return true;

    case "attach": {
      const agents = deps.store.getState().agents;
      if (agents.length > 0) {
        const lines = agents.map((a) => `  ${a.name} (${a.agentId})`);
        deps.addLifecycleMessage(
          `Available agents:\n${lines.join("\n")}\nUse /attach <name> to connect`,
        );
      } else {
        deps.addLifecycleMessage("No agents available. Use /dispatch to create one.");
      }
      return true;
    }

    case "dispatch":
      dispatchNewAgent(deps).catch(() => {});
      return true;

    case "suspend":
      runAgentCommand("suspend", (id) => deps.client.suspendAgent(id), deps);
      return true;

    case "resume":
      runAgentCommand("resume", (id) => deps.client.resumeAgent(id), deps);
      return true;

    case "terminate":
      deps.cancelActiveStream();
      runAgentCommand("terminate", (id) => deps.client.terminateAgent(id), deps);
      return true;

    case "cancel":
      deps.cancelActiveStream();
      deps.addLifecycleMessage("Stream cancelled");
      return true;

    case "sessions":
      deps.openSessionPicker().catch(() => {});
      return true;

    case "sources":
      deps.openDataSources().catch(() => {});
      return true;

    case "sources-add":
      deps.rescanDataSources().catch(() => {});
      return true;

    case "sources-approve": {
      const sources = deps.store.getState().dataSources;
      const pending = sources.filter((s) => s.status === "pending");
      if (pending.length > 0 && pending[0] !== undefined) {
        deps.approveDataSource(pending[0].name).catch(() => {});
      } else {
        deps.addLifecycleMessage("No pending data sources to approve");
      }
      return true;
    }

    case "sources-schema": {
      const allSources = deps.store.getState().dataSources;
      if (allSources.length > 0 && allSources[0] !== undefined) {
        deps.viewDataSourceSchema(allSources[0].name).catch(() => {});
      } else {
        deps.addLifecycleMessage("No data sources available");
      }
      return true;
    }

    case "logs":
      deps.showAgentLogs().catch(() => {});
      return true;

    case "health":
      deps.client
        .checkHealth()
        .then((r) => {
          if (r.ok) {
            deps.addLifecycleMessage(`Health: ${r.value.status}`);
          } else {
            deps.addLifecycleMessage(`Health check failed: ${r.error.kind}`);
          }
        })
        .catch(() => {});
      return true;

    case "open-browser":
      deps.openInBrowser();
      return true;

    case "split-panes": {
      const currentView = deps.store.getState().view;
      deps.store.dispatch({
        kind: "set_view",
        view: currentView === "splitpanes" ? "agents" : "splitpanes",
      });
      return true;
    }

    case "skills":
      deps.store.dispatch({ kind: "set_view", view: "skills" });
      return true;

    case "channels":
      deps.store.dispatch({ kind: "set_view", view: "channels" });
      return true;

    case "system":
      deps.store.dispatch({ kind: "set_view", view: "system" });
      return true;

    case "nexus":
      deps.store.dispatch({ kind: "set_view", view: "nexus" });
      return true;

    case "gateway":
      deps.store.dispatch({ kind: "set_view", view: "gateway" });
      return true;

    case "middleware":
      deps.store.dispatch({ kind: "set_view", view: "middleware" });
      return true;

    case "temporal":
      deps.store.dispatch({ kind: "set_view", view: "temporal" });
      return true;

    case "scheduler":
      deps.store.dispatch({ kind: "set_view", view: "scheduler" });
      return true;

    case "taskboard":
      deps.store.dispatch({ kind: "set_view", view: "taskboard" });
      return true;

    case "harness":
      deps.store.dispatch({ kind: "set_view", view: "harness" });
      return true;

    case "cost":
      deps.store.dispatch({ kind: "set_view", view: "cost" });
      return true;

    case "processtree":
      deps.store.dispatch({ kind: "set_view", view: "processtree" });
      return true;

    case "agentprocfs":
      deps.store.dispatch({ kind: "set_view", view: "agentprocfs" });
      return true;

    case "governance":
      deps.store.dispatch({ kind: "set_view", view: "governance" });
      return true;

    case "delegation":
      deps.store.dispatch({ kind: "set_view", view: "delegation" });
      return true;

    case "handoffs":
      deps.store.dispatch({ kind: "set_view", view: "handoffs" });
      return true;

    case "mailbox":
      deps.store.dispatch({ kind: "set_view", view: "mailbox" });
      return true;

    case "scratchpad":
      deps.store.dispatch({ kind: "set_view", view: "scratchpad" });
      return true;

    case "files":
      deps.store.dispatch({ kind: "set_view", view: "files" });
      return true;

    case "tree":
      deps.store.dispatch({ kind: "set_view", view: "processtree" });
      return true;

    case "quit":
      deps.stop().catch(() => {});
      return true;

    default:
      return false;
  }
}

/** Handle text that starts with / as a slash command. */
export function handleSlashCommand(text: string, deps: CommandDeps): void {
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0]?.slice(1);
  const arg = parts[1];

  if (cmd === "attach" && arg !== undefined) {
    const match = deps.store
      .getState()
      .agents.find((a) => a.name.toLowerCase() === arg.toLowerCase());
    if (match !== undefined) {
      deps.openAgentConsole(match.agentId);
    } else {
      deps.addLifecycleMessage(`Agent not found: ${arg}`);
    }
    return;
  }

  if (cmd !== undefined && dispatchCommand(cmd, deps)) {
    return;
  }
  deps.addLifecycleMessage(`Unknown command: ${text}`);
}

/** Navigate back from the current view. */
export function navigateBack(store: TuiStore): TuiView {
  const session = store.getState().activeSession;
  return session !== null ? "console" : "agents";
}

// ─── Helpers ────────────────────────────────────────────────────────────

function runAgentCommand(
  label: string,
  fn: (agentId: string) => Promise<ClientResult<null>>,
  deps: CommandDeps,
): void {
  const session = deps.store.getState().activeSession;
  if (session === null) return;
  fn(session.agentId)
    .then((r) => {
      deps.addLifecycleMessage(r.ok ? `Agent ${label}ed` : `${label} failed: ${r.error.kind}`);
      deps.refreshAgents().catch(() => {});
    })
    .catch(() => {});
}

async function dispatchNewAgent(deps: CommandDeps): Promise<void> {
  const result = await deps.client.dispatchAgent({
    name: `agent-${Date.now().toString(36)}`,
  });

  if (result.ok) {
    deps.addLifecycleMessage(`Dispatched agent: ${result.value.name} (${result.value.agentId})`);
    await deps.refreshAgents();
    deps.openAgentConsole(result.value.agentId);
  } else {
    if (result.error.kind === "api_error" && result.error.code === "NOT_FOUND") {
      deps.addLifecycleMessage(
        "Dispatch not available — server does not support agent dispatch yet",
      );
    } else {
      deps.addLifecycleMessage(`Dispatch failed: ${result.error.kind}`);
    }
  }
}
