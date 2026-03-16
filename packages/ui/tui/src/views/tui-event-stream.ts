/**
 * SSE event stream — extracted from tui-app.ts.
 *
 * Handles SSE connection, event parsing, domain forwarding, and consent prompts.
 */

import type {
  AgentDashboardEvent,
  DashboardEventBatch,
  DataSourceDashboardEvent,
} from "@koi/dashboard-types";
import { isAgentEvent, isDataSourceEvent, isPtyOutputEvent } from "@koi/dashboard-types";
import type { TuiStore } from "../state/store.js";
import type { TuiState, TuiView } from "../state/types.js";

/** Map a TuiView to its domain key for scroll dispatching. */
export function viewToDomainKey(view: TuiView): string | null {
  const map: Readonly<Record<string, string>> = {
    skills: "skills",
    channels: "channels",
    system: "system",
    nexus: "nexus",
    gateway: "gateway",
    temporal: "temporal",
    scheduler: "scheduler",
    taskboard: "taskboard",
    harness: "harness",
    governance: "governance",
    middleware: "middleware",
    processtree: "processtree",
    agentprocfs: "agentprocfs",
    cost: "cost",
  };
  return map[view] ?? null;
}

/** Get the scroll offset for a domain view. */
export function getDomainScrollOffset(state: TuiState, domain: string): number {
  switch (domain) {
    case "skills":
      return state.skillsView.scrollOffset;
    case "channels":
      return state.channelsView.scrollOffset;
    case "system":
      return state.systemView.scrollOffset;
    case "nexus":
      return state.nexusView.scrollOffset;
    case "gateway":
      return state.gatewayView.scrollOffset;
    case "temporal":
      return state.temporalView.scrollOffset;
    case "scheduler":
      return state.schedulerView.scrollOffset;
    case "taskboard":
      return state.taskBoardView.scrollOffset;
    case "harness":
      return state.harnessView.scrollOffset;
    case "governance":
      return state.governanceView.scrollOffset;
    case "middleware":
      return state.middlewareView.scrollOffset;
    case "processtree":
      return state.processTreeView.scrollOffset;
    case "agentprocfs":
      return state.agentProcfsView.scrollOffset;
    case "cost":
      return state.costView.scrollOffset;
    default:
      return 0;
  }
}

/** Dependencies for view-open data fetching. */
export interface ViewDataFetchDeps {
  readonly store: TuiStore;
  readonly client: import("@koi/dashboard-client").AdminClient;
}

/** Fetch data when a domain view is opened. */
export function fetchDataForView(view: TuiView, deps: ViewDataFetchDeps): void {
  const { store, client } = deps;
  switch (view) {
    case "skills":
      client
        .listSkills()
        .then((r) => {
          if (r.ok) store.dispatch({ kind: "set_skills_list", skills: r.value });
        })
        .catch(() => {});
      break;
    case "channels":
      client
        .listChannels()
        .then((r) => {
          if (r.ok) store.dispatch({ kind: "set_channels_list", channels: r.value });
        })
        .catch(() => {});
      client
        .getGatewayTopology()
        .then((r) => {
          if (r.ok) store.dispatch({ kind: "set_gateway_topology", topology: r.value });
        })
        .catch(() => {});
      break;
    case "system":
      client
        .getMetrics()
        .then((r) => {
          if (r.ok) store.dispatch({ kind: "set_system_metrics", metrics: r.value });
        })
        .catch(() => {});
      break;
    case "gateway":
      client
        .getGatewayTopology()
        .then((r) => {
          if (r.ok) store.dispatch({ kind: "set_gateway_topology", topology: r.value });
        })
        .catch(() => {});
      break;
    case "temporal":
      client
        .getTemporalHealth()
        .then((r) => {
          if (r.ok) store.dispatch({ kind: "set_temporal_health", health: r.value });
        })
        .catch(() => {});
      client
        .listWorkflows()
        .then((r) => {
          if (r.ok) store.dispatch({ kind: "set_temporal_workflows", workflows: r.value });
        })
        .catch(() => {});
      break;
    case "scheduler":
      client
        .getSchedulerStats()
        .then((r) => {
          if (r.ok) store.dispatch({ kind: "set_scheduler_stats", stats: r.value });
        })
        .catch(() => {});
      client
        .listSchedulerTasks()
        .then((r) => {
          if (r.ok) store.dispatch({ kind: "set_scheduler_tasks", tasks: r.value });
        })
        .catch(() => {});
      client
        .listSchedules()
        .then((r) => {
          if (r.ok) store.dispatch({ kind: "set_scheduler_schedules", schedules: r.value });
        })
        .catch(() => {});
      client
        .listDeadLetters()
        .then((r) => {
          if (r.ok) store.dispatch({ kind: "set_scheduler_dead_letters", entries: r.value });
        })
        .catch(() => {});
      break;
    case "taskboard":
      client
        .getTaskBoardSnapshot()
        .then((r) => {
          if (r.ok) store.dispatch({ kind: "set_taskboard_snapshot", snapshot: r.value });
        })
        .catch(() => {});
      break;
    case "harness":
      client
        .getHarnessStatus()
        .then((r) => {
          if (r.ok) store.dispatch({ kind: "set_harness_status", status: r.value });
        })
        .catch(() => {});
      client
        .listCheckpoints()
        .then((r) => {
          if (r.ok) store.dispatch({ kind: "set_harness_checkpoints", checkpoints: r.value });
        })
        .catch(() => {});
      break;
    case "middleware": {
      const sess = store.getState().activeSession;
      if (sess !== null) {
        store.dispatch({ kind: "set_middleware_loading", loading: true });
        client
          .getMiddlewareChain(sess.agentId)
          .then((r) => {
            if (r.ok) store.dispatch({ kind: "set_middleware_chain", chain: r.value });
          })
          .catch(() => {});
      }
      break;
    }
    case "processtree":
      store.dispatch({ kind: "set_process_tree_loading", loading: true });
      client
        .getProcessTree()
        .then((r) => {
          if (r.ok) store.dispatch({ kind: "set_process_tree", snapshot: r.value });
        })
        .catch(() => {});
      break;
    case "agentprocfs": {
      const sess2 = store.getState().activeSession;
      if (sess2 !== null) {
        store.dispatch({ kind: "set_agent_procfs_loading", loading: true });
        client
          .getAgentProcfs(sess2.agentId)
          .then((r) => {
            if (r.ok) store.dispatch({ kind: "set_agent_procfs", procfs: r.value });
          })
          .catch(() => {});
      }
      break;
    }
  }
}

// ─── Domain action helpers ────────────────────────────────────────────

/** Dependencies for domain operator actions. */
export interface DomainActionDeps {
  readonly store: TuiStore;
  readonly client: import("@koi/dashboard-client").AdminClient;
  readonly addLifecycleMessage: (event: string) => void;
}

export function temporalDetail(deps: DomainActionDeps): void {
  const tw = deps.store.getState().temporalView;
  const wf = tw.workflows[tw.selectedWorkflowIndex];
  if (wf !== undefined) {
    deps.client
      .getWorkflow(wf.workflowId)
      .then((r) => {
        if (r.ok) deps.store.dispatch({ kind: "set_temporal_workflow_detail", detail: r.value });
      })
      .catch(() => {});
  }
}

export function temporalSignal(deps: DomainActionDeps): void {
  const tw = deps.store.getState().temporalView;
  const wf = tw.workflows[tw.selectedWorkflowIndex];
  if (wf !== undefined) {
    deps.client
      .signalWorkflow(wf.workflowId, "refresh")
      .then((r) => {
        if (r.ok) deps.addLifecycleMessage(`Signal sent to ${wf.workflowId}`);
        else deps.addLifecycleMessage(`Signal failed: ${r.error.kind}`);
      })
      .catch(() => {});
  }
}

export function temporalTerminate(deps: DomainActionDeps): void {
  const tw = deps.store.getState().temporalView;
  const wf = tw.workflows[tw.selectedWorkflowIndex];
  if (wf !== undefined) {
    deps.client
      .terminateWorkflow(wf.workflowId)
      .then((r) => {
        if (r.ok) deps.addLifecycleMessage(`Terminated ${wf.workflowId}`);
        else deps.addLifecycleMessage(`Terminate failed: ${r.error.kind}`);
      })
      .catch(() => {});
  }
}

export function schedulerRetryDlq(deps: DomainActionDeps): void {
  const dl = deps.store.getState().schedulerView.deadLetters[0];
  if (dl !== undefined) {
    deps.client
      .retryDeadLetter(dl.entryId)
      .then((r) => {
        if (r.ok) deps.addLifecycleMessage(`Retried dead letter ${dl.entryId}`);
        else deps.addLifecycleMessage(`Retry failed: ${r.error.kind}`);
      })
      .catch(() => {});
  }
}

export function harnessPauseResume(deps: DomainActionDeps): void {
  const hv = deps.store.getState().harnessView;
  if (hv.status === null) return;
  const isPaused = hv.status.phase === "paused";
  const action = isPaused ? deps.client.resumeHarness() : deps.client.pauseHarness();
  action
    .then((r) => {
      if (r.ok) deps.addLifecycleMessage(`Harness ${isPaused ? "resumed" : "paused"}`);
      else deps.addLifecycleMessage(`Harness action failed: ${r.error.kind}`);
    })
    .catch(() => {});
}

export function governanceApprove(deps: DomainActionDeps): void {
  const gv = deps.store.getState().governanceView;
  const item = gv.pendingApprovals[gv.selectedIndex];
  if (item !== undefined) {
    deps.store.dispatch({ kind: "remove_governance_approval", id: item.id });
    deps.addLifecycleMessage(`Approved: ${item.action} on ${item.resource}`);
  }
}

export function governanceDeny(deps: DomainActionDeps): void {
  const gv = deps.store.getState().governanceView;
  const item = gv.pendingApprovals[gv.selectedIndex];
  if (item !== undefined) {
    deps.store.dispatch({ kind: "remove_governance_approval", id: item.id });
    deps.addLifecycleMessage(`Denied: ${item.action} on ${item.resource}`);
  }
}

// ─── SSE event stream handle ──────────────────────────────────────────

/** Handle returned by createEventStream. */
export interface EventStreamHandle {
  readonly start: () => void;
  readonly stop: () => void;
}

/** Dependencies for creating an event stream. */
export interface EventStreamDeps {
  readonly store: TuiStore;
  readonly eventsUrl: string;
  readonly authToken?: string;
  readonly createReconnectingStream: typeof import("@koi/dashboard-client").createReconnectingStream;
  readonly onBatch: (batch: import("@koi/dashboard-types").DashboardEventBatch) => void;
}

/** Create a managed SSE event stream with reconnection. */
export function createEventStream(deps: EventStreamDeps): EventStreamHandle {
  let stream: import("@koi/dashboard-client").ReconnectHandle | null = null;
  const hdrs: Record<string, string> = {};
  if (deps.authToken !== undefined) {
    hdrs.Authorization = `Bearer ${deps.authToken}`;
  }

  return {
    start(): void {
      if (stream !== null) return;
      stream = deps.createReconnectingStream(
        async (lastEventId) => {
          const fetchHeaders: Record<string, string> = { ...hdrs };
          if (lastEventId !== undefined) {
            fetchHeaders["Last-Event-ID"] = lastEventId;
          }
          return fetch(deps.eventsUrl, { headers: fetchHeaders });
        },
        {
          onEvent: (event) => {
            try {
              const batch: unknown = JSON.parse(event.data);
              if (
                typeof batch === "object" &&
                batch !== null &&
                "events" in batch &&
                "seq" in batch &&
                "timestamp" in batch
              ) {
                deps.onBatch(batch as import("@koi/dashboard-types").DashboardEventBatch);
              }
            } catch {
              // Malformed SSE data — skip
            }
          },
          onStatus: (status) => {
            switch (status.kind) {
              case "connected":
                deps.store.dispatch({ kind: "set_connection_status", status: "connected" });
                break;
              case "reconnecting":
                deps.store.dispatch({ kind: "set_connection_status", status: "reconnecting" });
                break;
              case "failed":
                deps.store.dispatch({ kind: "set_connection_status", status: "disconnected" });
                break;
            }
          },
        },
        { maxAttempts: 10, initialDelayMs: 500, maxDelayMs: 10_000 },
      );
    },
    stop(): void {
      if (stream !== null) {
        stream.stop();
        stream = null;
      }
    },
  };
}

/** Dependencies for event forwarding. */
export interface EventForwardDeps {
  readonly store: TuiStore;
  readonly addLifecycleMessage: (event: string) => void;
  readonly openDataSources: () => Promise<void>;
  readonly forwardConsentPrompts: (hasDiscovery: boolean) => void;
}

/** Forward SSE agent events to the active console session. */
export function forwardAgentEventsToConsole(
  batch: DashboardEventBatch,
  deps: EventForwardDeps,
): void {
  const session = deps.store.getState().activeSession;
  for (const evt of batch.events) {
    if (isPtyOutputEvent(evt)) {
      deps.store.dispatch({ kind: "append_pty_data", agentId: evt.agentId, data: evt.data });
      continue;
    }
    if (isDataSourceEvent(evt)) {
      const desc = formatDataSourceEvent(evt);
      if (desc !== null) {
        deps.addLifecycleMessage(desc);
        if (evt.subKind === "data_source_discovered") {
          deps.openDataSources().catch(() => {});
        }
      }
      continue;
    }
    if (session === null) continue;
    if (!isAgentEvent(evt)) continue;
    if (evt.agentId !== session.agentId) continue;
    const desc = formatAgentEvent(evt);
    if (desc !== null) deps.addLifecycleMessage(desc);
  }
}

/** Check for consent-requiring events in a batch. */
export function checkConsentPrompts(batch: DashboardEventBatch, deps: EventForwardDeps): void {
  let hasDiscovery = false;
  for (const evt of batch.events) {
    if (isDataSourceEvent(evt) && evt.subKind === "data_source_discovered") {
      hasDiscovery = true;
      break;
    }
  }
  deps.forwardConsentPrompts(hasDiscovery);
}

/** Format an agent event for display. */
export function formatAgentEvent(evt: AgentDashboardEvent): string | null {
  switch (evt.subKind) {
    case "status_changed":
      return `Agent state: ${evt.from} → ${evt.to}`;
    case "dispatched":
      return `Agent dispatched: ${evt.name}`;
    case "terminated":
      return `Agent terminated${evt.reason !== undefined ? `: ${evt.reason}` : ""}`;
    case "metrics_updated":
      return `Turns: ${String(evt.turns)}, tokens: ${String(evt.tokenCount)}`;
    default:
      return null;
  }
}

/** Format a data source event for display. */
export function formatDataSourceEvent(evt: DataSourceDashboardEvent): string | null {
  switch (evt.subKind) {
    case "data_source_discovered":
      return `Data source discovered: ${evt.name} (${evt.protocol}) from ${evt.source}`;
    case "connector_forged":
      return `Connector forged for: ${evt.name} (${evt.protocol})`;
    case "connector_health_update":
      return `Connector ${evt.name}: ${evt.healthy ? "healthy" : "unhealthy"}`;
    default:
      return null;
  }
}
