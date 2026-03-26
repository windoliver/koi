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
import {
  isAgentEvent,
  isDataSourceEvent,
  isLogEvent,
  isPtyOutputEvent,
} from "@koi/dashboard-types";
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
    debug: "debug",
    delegation: "delegation",
    handoffs: "handoffs",
    mailbox: "mailbox",
    scratchpad: "scratchpad",
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
    case "delegation":
      return state.delegationView.scrollOffset;
    case "handoffs":
      return state.handoffView.scrollOffset;
    case "mailbox":
      return state.mailboxView.scrollOffset;
    case "scratchpad":
      return state.scratchpadView.scrollOffset;
    case "debug":
      return state.debugView.scrollOffset;
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
    case "delegation": {
      const sess3 = store.getState().activeSession;
      if (sess3 !== null) {
        store.dispatch({ kind: "set_delegation_loading", loading: true });
        client
          .listDelegations(sess3.agentId)
          .then((r) => {
            if (r.ok) store.dispatch({ kind: "set_delegations", delegations: r.value });
          })
          .catch(() => {});
      }
      break;
    }
    case "handoffs": {
      const sess4 = store.getState().activeSession;
      if (sess4 !== null) {
        store.dispatch({ kind: "set_handoff_loading", loading: true });
        client
          .listHandoffs(sess4.agentId)
          .then((r) => {
            if (r.ok) store.dispatch({ kind: "set_handoffs", handoffs: r.value });
          })
          .catch(() => {});
      }
      break;
    }
    case "mailbox": {
      const targetId =
        store.getState().mailboxTargetAgentId ?? store.getState().activeSession?.agentId;
      if (targetId !== undefined && targetId !== null) {
        store.dispatch({ kind: "set_mailbox_loading", loading: true });
        client
          .listMailbox(targetId)
          .then((r) => {
            if (r.ok) store.dispatch({ kind: "set_mailbox_messages", messages: r.value });
          })
          .catch(() => {});
      }
      // Clear the override after use
      store.dispatch({ kind: "set_mailbox_target", agentId: null });
      break;
    }
    case "scratchpad":
      store.dispatch({ kind: "set_scratchpad_loading", loading: true });
      client
        .listScratchpad()
        .then((r) => {
          if (r.ok) store.dispatch({ kind: "set_scratchpad_entries", entries: r.value });
        })
        .catch(() => {});
      break;
    case "files":
      store.dispatch({ kind: "set_nexus_browser_loading", loading: true });
      client
        .fsList(store.getState().nexusBrowser.path)
        .then((r) => {
          if (r.ok)
            store.dispatch({
              kind: "set_nexus_browser_entries",
              entries: r.value,
              path: store.getState().nexusBrowser.path,
            });
        })
        .catch(() => {});
      break;
    case "debug": {
      const state5 = store.getState();
      const debugAgentId = state5.activeSession?.agentId ?? state5.agents[0]?.agentId;
      if (debugAgentId !== undefined) {
        store.dispatch({ kind: "set_debug_loading", loading: true });
        client
          .getDebugInventory(debugAgentId)
          .then((r) => {
            if (r.ok) {
              store.dispatch({ kind: "set_debug_inventory", items: r.value.items });
              // Only fetch contributions when inventory has data (primary agent).
              // Non-primary agents get empty inventory, so contributions would be misleading.
              if (r.value.items.length > 0) {
                client
                  .getDebugContributions()
                  .then((cr) => {
                    if (cr.ok)
                      store.dispatch({ kind: "set_debug_contributions", contributions: cr.value });
                  })
                  .catch(() => {});
              } else {
                store.dispatch({ kind: "set_debug_contributions", contributions: null });
              }
            }
          })
          .catch(() => {});
        const turnIndex = store.getState().debugView.selectedTurnIndex;
        client
          .getDebugTrace(debugAgentId, turnIndex)
          .then((r) => {
            if (r.ok) store.dispatch({ kind: "set_debug_trace", trace: r.value });
            else store.dispatch({ kind: "set_debug_trace", trace: null });
          })
          .catch(() => {});
      }
      break;
    }
    case "governance":
      client
        .listGovernanceQueue()
        .then((r) => {
          if (r.ok) {
            // Replace the full list from server snapshot — reconciles removals
            store.dispatch({
              kind: "set_governance_approvals",
              approvals: r.value.map((item) => ({
                id: item.id,
                agentId: item.agentId,
                action: item.requestKind,
                resource: JSON.stringify(item.payload).slice(0, 40),
                timestamp: item.timestamp,
              })),
            });
          }
        })
        .catch(() => {});
      break;
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

/** Governance approve — directly approves the selected item and returns to console. */
export function governanceApprove(deps: DomainActionDeps): void {
  const gv = deps.store.getState().governanceView;
  const item = gv.pendingApprovals[gv.selectedIndex];
  if (item === undefined) return;

  deps.store.dispatch({ kind: "remove_governance_approval", id: item.id });
  deps.client
    .reviewGovernance(item.id, "approved")
    .then((r) => {
      if (r.ok) deps.addLifecycleMessage(`Approved: ${item.action} for ${item.agentId}`);
      else deps.addLifecycleMessage(`Approve failed: ${r.error.kind}`);
    })
    .catch(() => {});

  // Always return to console after approving — the agent is waiting for the result
  deps.store.dispatch({ kind: "set_view", view: "console" });
}

/** Governance deny — directly denies the selected item and returns to console. */
export function governanceDeny(deps: DomainActionDeps): void {
  const gv = deps.store.getState().governanceView;
  const item = gv.pendingApprovals[gv.selectedIndex];
  if (item === undefined) return;

  deps.store.dispatch({ kind: "remove_governance_approval", id: item.id });
  deps.client
    .reviewGovernance(item.id, "rejected")
    .then((r) => {
      if (r.ok) deps.addLifecycleMessage(`Denied: ${item.action} for ${item.agentId}`);
      else deps.addLifecycleMessage(`Deny failed: ${r.error.kind}`);
    })
    .catch(() => {});

  // Always return to console after denying
  deps.store.dispatch({ kind: "set_view", view: "console" });
}

/** Promote the selected forge brick via API. */
export function forgePromoteBrick(deps: DomainActionDeps, brickId: string): void {
  deps.client
    .promoteBrick(brickId)
    .then((r) => {
      if (r.ok) deps.addLifecycleMessage(`Promoted brick: ${brickId}`);
      else deps.addLifecycleMessage(`Promote failed: ${r.error.kind}`);
    })
    .catch(() => {});
}

/** Demote the selected forge brick via API. */
export function forgeDemoteBrick(deps: DomainActionDeps, brickId: string): void {
  deps.client
    .demoteBrick(brickId)
    .then((r) => {
      if (r.ok) deps.addLifecycleMessage(`Demoted brick: ${brickId}`);
      else deps.addLifecycleMessage(`Demote failed: ${r.error.kind}`);
    })
    .catch(() => {});
}

/** Quarantine the selected forge brick via API. */
export function forgeQuarantineBrick(deps: DomainActionDeps, brickId: string): void {
  deps.client
    .quarantineBrick(brickId)
    .then((r) => {
      if (r.ok) deps.addLifecycleMessage(`Quarantined brick: ${brickId}`);
      else deps.addLifecycleMessage(`Quarantine failed: ${r.error.kind}`);
    })
    .catch(() => {});
}

/** Open a nexus directory or read a file. */
export function nexusBrowserNavigate(
  deps: DomainActionDeps,
  path: string,
  isDirectory: boolean,
): void {
  if (isDirectory) {
    deps.store.dispatch({ kind: "set_nexus_browser_loading", loading: true });
    deps.store.dispatch({ kind: "set_nexus_browser_content", content: null });
    deps.client
      .fsList(path)
      .then((r) => {
        if (r.ok)
          deps.store.dispatch({ kind: "set_nexus_browser_entries", entries: r.value, path });
      })
      .catch(() => {});
  } else {
    deps.store.dispatch({ kind: "set_nexus_browser_loading", loading: true });
    deps.client
      .fsRead(path)
      .then((r) => {
        if (!r.ok) return;
        // fsRead returns { content, editable } but client types it as string
        const raw = r.value as unknown;
        const text =
          typeof raw === "string"
            ? raw
            : typeof raw === "object" && raw !== null && "content" in raw
              ? String((raw as Record<string, unknown>).content)
              : String(raw);
        deps.store.dispatch({ kind: "set_nexus_browser_content", content: text });
      })
      .catch(() => {});
  }
}

/** Read scratchpad entry content. */
export function scratchpadReadEntry(deps: DomainActionDeps, path: string): void {
  deps.store.dispatch({ kind: "set_scratchpad_loading", loading: true });
  deps.client
    .readScratchpad(path)
    .then((r) => {
      if (r.ok) deps.store.dispatch({ kind: "set_scratchpad_detail", detail: r.value });
      else deps.addLifecycleMessage(`Read failed: ${r.error.kind}`);
    })
    .catch(() => {});
}

/** Pre-bound keyboard callbacks for new views (forge/nexus/scratchpad). */
export interface NewViewCallbacks {
  readonly forgeSelectNext: () => void;
  readonly forgeSelectPrev: () => void;
  readonly forgePromote: () => void;
  readonly forgeDemote: () => void;
  readonly forgeQuarantine: () => void;
  readonly nexusBrowserSelectNext: () => void;
  readonly nexusBrowserSelectPrev: () => void;
  readonly nexusBrowserOpen: () => void;
  readonly nexusBrowserBack: () => void;
  readonly scratchpadOpen: () => void;
}

/** Get the brick ID at the current forge selection index. */
function selectedBrickId(store: TuiStore): string | undefined {
  const keys = Object.keys(store.getState().forgeBricks);
  return keys[store.getState().forgeSelectedBrickIndex];
}

/** Create pre-bound callbacks for forge/nexus/scratchpad keyboard actions. */
export function createNewViewCallbacks(deps: DomainActionDeps): NewViewCallbacks {
  const { store } = deps;
  return {
    forgeSelectNext: () => {
      store.dispatch({
        kind: "select_forge_brick",
        index: store.getState().forgeSelectedBrickIndex + 1,
      });
    },
    forgeSelectPrev: () => {
      store.dispatch({
        kind: "select_forge_brick",
        index: store.getState().forgeSelectedBrickIndex - 1,
      });
    },
    forgePromote: () => {
      const id = selectedBrickId(store);
      if (id !== undefined) forgePromoteBrick(deps, id);
    },
    forgeDemote: () => {
      const id = selectedBrickId(store);
      if (id !== undefined) forgeDemoteBrick(deps, id);
    },
    forgeQuarantine: () => {
      const id = selectedBrickId(store);
      if (id !== undefined) forgeQuarantineBrick(deps, id);
    },
    nexusBrowserSelectNext: () => {
      store.dispatch({
        kind: "select_nexus_browser_entry",
        index: store.getState().nexusBrowser.selectedIndex + 1,
      });
    },
    nexusBrowserSelectPrev: () => {
      store.dispatch({
        kind: "select_nexus_browser_entry",
        index: store.getState().nexusBrowser.selectedIndex - 1,
      });
    },
    nexusBrowserOpen: () => {
      const nb = store.getState().nexusBrowser;
      const e = nb.entries[nb.selectedIndex];
      if (e !== undefined) nexusBrowserNavigate(deps, e.path, e.isDirectory);
    },
    nexusBrowserBack: () => {
      const nb = store.getState().nexusBrowser;
      if (nb.fileContent !== null) {
        store.dispatch({ kind: "set_nexus_browser_content", content: null });
      } else if (nb.path !== "/") {
        nexusBrowserNavigate(deps, nb.path.split("/").slice(0, -1).join("/") || "/", true);
      } else {
        store.dispatch({
          kind: "set_view",
          view: store.getState().activeSession !== null ? "console" : "agents",
        });
      }
    },
    scratchpadOpen: () => {
      const sv = store.getState().scratchpadView;
      const e = sv.entries[sv.scrollOffset];
      if (e !== undefined) scratchpadReadEntry(deps, e.path);
    },
  };
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
    if (isLogEvent(evt)) {
      deps.store.dispatch({
        kind: "append_log",
        entry: {
          level: evt.level,
          source: evt.source,
          message: evt.message,
          timestamp: evt.timestamp,
        },
      });
      continue;
    }
    if (evt.kind === "governance" && evt.subKind === "approval_required") {
      deps.store.dispatch({
        kind: "add_governance_approval",
        approval: {
          id: evt.approvalId,
          agentId: evt.agentId,
          action: evt.action,
          resource: evt.resource,
          timestamp: evt.timestamp,
        },
      });
      // Auto-switch to governance view immediately
      if (deps.store.getState().view !== "governance") {
        deps.store.dispatch({ kind: "set_view", view: "governance" });
        deps.addLifecycleMessage(`⚠ Governance approval required — ${evt.action}`);
      }
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
