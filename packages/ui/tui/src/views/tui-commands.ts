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
  readonly onServiceCommand?: ((command: string) => Promise<void>) | undefined;
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
      deps.store.dispatch({ kind: "toggle_agent_list_mode" });
      if (deps.store.getState().view !== "agents") {
        deps.store.dispatch({ kind: "set_view", view: "agents" });
      }
      deps.addLifecycleMessage(`Agent list: ${deps.store.getState().agentListMode} mode`);
      return true;

    case "approve":
      runGovernanceAction("approved", deps);
      return true;

    case "deny":
      runGovernanceAction("rejected", deps);
      return true;

    case "workflow-signal":
      runWorkflowSignal(deps);
      return true;

    case "workflow-terminate":
      runWorkflowTerminate(deps);
      return true;

    case "schedule-pause":
      runScheduleAction("pause", deps);
      return true;

    case "schedule-resume":
      runScheduleAction("resume", deps);
      return true;

    case "dlq-retry":
      runDlqRetry(deps);
      return true;

    case "harness-pause":
      runHarnessAction("pause", deps);
      return true;

    case "harness-resume":
      runHarnessAction("resume", deps);
      return true;

    case "quit":
      deps.stop().catch(() => {});
      return true;

    case "stop":
      deps.client
        .shutdown()
        .then((r) => {
          deps.addLifecycleMessage(
            r.ok ? "Shutdown initiated" : `Shutdown failed: ${r.error.kind}`,
          );
        })
        .catch(() => {});
      return true;

    case "status":
      deps.client
        .detailedStatus()
        .then((r) => {
          if (r.ok) {
            deps.store.dispatch({ kind: "set_service_status", status: r.value });
            deps.store.dispatch({ kind: "set_view", view: "service" });
          } else {
            deps.addLifecycleMessage(`Status failed: ${r.error.kind}`);
          }
        })
        .catch(() => {});
      return true;

    case "doctor":
      deps.store.dispatch({ kind: "clear_doctor_checks" });
      deps.store.dispatch({ kind: "set_view", view: "doctor" });
      deps.onServiceCommand?.("doctor").catch(() => {});
      return true;

    case "demo-init":
      deps.onServiceCommand?.("demo-init").catch(() => {});
      return true;

    case "demo-reset":
      deps.onServiceCommand?.("demo-reset").catch(() => {});
      return true;

    case "deploy":
      deps.client
        .deploy()
        .then((r) => {
          deps.addLifecycleMessage(r.ok ? "Deploy initiated" : `Deploy failed: ${r.error.kind}`);
        })
        .catch(() => {});
      return true;

    case "undeploy":
      deps.client
        .undeploy()
        .then((r) => {
          deps.addLifecycleMessage(
            r.ok ? "Undeploy initiated" : `Undeploy failed: ${r.error.kind}`,
          );
        })
        .catch(() => {});
      return true;

    case "demo-list":
      deps.client
        .demoPacks()
        .then((r) => {
          if (r.ok) {
            const lines = r.value.map((p) => `  ${p.id}: ${p.description}`);
            deps.addLifecycleMessage(
              lines.length > 0
                ? `Available demo packs:\n${lines.join("\n")}`
                : "No demo packs available",
            );
          } else {
            deps.addLifecycleMessage(`Failed to list demo packs: ${r.error.kind}`);
          }
        })
        .catch(() => {});
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

  // /mailbox <agentId> — target a specific agent's mailbox
  if (cmd === "mailbox" && arg !== undefined) {
    const match = resolveAgent(arg, deps);
    if (match !== undefined) {
      deps.store.dispatch({ kind: "set_mailbox_target", agentId: match });
    }
    deps.store.dispatch({ kind: "set_view", view: "mailbox" });
    return;
  }

  // Multi-word commands: /workflow signal|terminate, /schedule pause|resume
  if (cmd === "workflow" && arg !== undefined) {
    if (arg === "signal") {
      dispatchCommand("workflow-signal", deps);
      return;
    }
    if (arg === "terminate") {
      dispatchCommand("workflow-terminate", deps);
      return;
    }
    deps.addLifecycleMessage(`Unknown workflow subcommand: ${arg}. Use signal or terminate.`);
    return;
  }
  if (cmd === "schedule" && arg !== undefined) {
    if (arg === "pause") {
      dispatchCommand("schedule-pause", deps);
      return;
    }
    if (arg === "resume") {
      dispatchCommand("schedule-resume", deps);
      return;
    }
    deps.addLifecycleMessage(`Unknown schedule subcommand: ${arg}. Use pause or resume.`);
    return;
  }
  if (cmd === "dlq" && arg === "retry") {
    dispatchCommand("dlq-retry", deps);
    return;
  }
  if (cmd === "harness" && arg !== undefined) {
    if (arg === "pause") {
      dispatchCommand("harness-pause", deps);
      return;
    }
    if (arg === "resume") {
      dispatchCommand("harness-resume", deps);
      return;
    }
    deps.addLifecycleMessage(`Unknown harness subcommand: ${arg}. Use pause or resume.`);
    return;
  }

  if (cmd !== undefined && dispatchCommand(cmd, deps)) {
    return;
  }
  deps.addLifecycleMessage(`Unknown command: ${text}`);
}

/** Resolve agent name or ID to an agent ID. */
function resolveAgent(nameOrId: string, deps: CommandDeps): string | undefined {
  const agents = deps.store.getState().agents;
  const match = agents.find(
    (a) => a.agentId === nameOrId || a.name.toLowerCase() === nameOrId.toLowerCase(),
  );
  if (match !== undefined) return match.agentId;
  deps.addLifecycleMessage(`Agent not found: ${nameOrId}`);
  return undefined;
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

function runGovernanceAction(decision: "approved" | "rejected", deps: CommandDeps): void {
  const gv = deps.store.getState().governanceView;
  const item = gv.pendingApprovals[gv.selectedIndex];
  if (item === undefined) {
    deps.addLifecycleMessage("No pending governance item selected");
    return;
  }
  deps.store.dispatch({ kind: "remove_governance_approval", id: item.id });
  deps.client
    .reviewGovernance(item.id, decision)
    .then((r) => {
      const label = decision === "approved" ? "Approved" : "Denied";
      if (r.ok) deps.addLifecycleMessage(`${label}: ${item.action} on ${item.resource}`);
      else deps.addLifecycleMessage(`${label} failed: ${r.error.kind}`);
    })
    .catch(() => {});
}

function runWorkflowSignal(deps: CommandDeps): void {
  const tw = deps.store.getState().temporalView;
  const wf = tw.workflows[tw.selectedWorkflowIndex];
  if (wf === undefined) {
    deps.addLifecycleMessage("No workflow selected");
    return;
  }
  deps.client
    .signalWorkflow(wf.workflowId, "refresh")
    .then((r) => {
      if (r.ok) deps.addLifecycleMessage(`Signal sent to ${wf.workflowId}`);
      else deps.addLifecycleMessage(`Signal failed: ${r.error.kind}`);
    })
    .catch(() => {});
}

function runWorkflowTerminate(deps: CommandDeps): void {
  const tw = deps.store.getState().temporalView;
  const wf = tw.workflows[tw.selectedWorkflowIndex];
  if (wf === undefined) {
    deps.addLifecycleMessage("No workflow selected");
    return;
  }
  deps.client
    .terminateWorkflow(wf.workflowId)
    .then((r) => {
      if (r.ok) deps.addLifecycleMessage(`Terminated ${wf.workflowId}`);
      else deps.addLifecycleMessage(`Terminate failed: ${r.error.kind}`);
    })
    .catch(() => {});
}

function runScheduleAction(action: "pause" | "resume", deps: CommandDeps): void {
  const sv = deps.store.getState().schedulerView;
  const schedule = sv.schedules[0];
  if (schedule === undefined) {
    deps.addLifecycleMessage("No schedules available");
    return;
  }
  const fn = action === "pause" ? deps.client.pauseSchedule : deps.client.resumeSchedule;
  fn(schedule.scheduleId)
    .then((r) => {
      if (r.ok) deps.addLifecycleMessage(`Schedule ${schedule.scheduleId} ${action}d`);
      else deps.addLifecycleMessage(`Schedule ${action} failed: ${r.error.kind}`);
    })
    .catch(() => {});
}

function runDlqRetry(deps: CommandDeps): void {
  const dl = deps.store.getState().schedulerView.deadLetters[0];
  if (dl === undefined) {
    deps.addLifecycleMessage("No dead letter entries");
    return;
  }
  deps.client
    .retryDeadLetter(dl.entryId)
    .then((r) => {
      if (r.ok) deps.addLifecycleMessage(`Retried dead letter ${dl.entryId}`);
      else deps.addLifecycleMessage(`Retry failed: ${r.error.kind}`);
    })
    .catch(() => {});
}

function runHarnessAction(action: "pause" | "resume", deps: CommandDeps): void {
  const fn = action === "pause" ? deps.client.pauseHarness : deps.client.resumeHarness;
  fn()
    .then((r) => {
      if (r.ok) deps.addLifecycleMessage(`Harness ${action}d`);
      else deps.addLifecycleMessage(`Harness ${action} failed: ${r.error.kind}`);
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
