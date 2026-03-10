/**
 * TemporalTab — workflow list with status, health indicator, signal/terminate actions.
 */

import type { TemporalHealth, WorkflowSummary } from "@koi/dashboard-types";
import { useCallback, useState } from "react";
import { useRuntimeView } from "../../hooks/use-runtime-view.js";
import { formatDuration, formatRelativeTime } from "../../lib/format.js";
import { signalWorkflow, terminateWorkflow } from "../../lib/api-client.js";
import { LoadingSkeleton } from "../shared/loading-skeleton.js";
import { WorkflowDetailPanel } from "./workflow-detail-panel.js";

const STATUS_COLORS: Readonly<Record<string, string>> = {
  running: "text-blue-400",
  completed: "text-green-400",
  failed: "text-red-400",
  cancelled: "text-yellow-400",
  terminated: "text-orange-400",
  timed_out: "text-red-300",
} as const;

function deriveTemporalUiUrl(serverAddress: string): string {
  const host = serverAddress.includes(":")
    ? serverAddress.slice(0, serverAddress.indexOf(":"))
    : serverAddress;
  return `http://${host}:8233`;
}

function HealthIndicator({ health }: { readonly health: TemporalHealth }): React.ReactElement {
  const uiUrl = deriveTemporalUiUrl(health.serverAddress);

  return (
    <div className="flex items-center gap-2 rounded border border-[var(--color-border,#444)] px-3 py-2">
      <div
        className={`h-2 w-2 rounded-full ${health.healthy ? "bg-green-400" : "bg-red-400"}`}
      />
      <span className="text-xs text-[var(--color-foreground,#cdd6f4)]">
        {health.healthy ? "Healthy" : "Unhealthy"}
      </span>
      <span className="text-xs text-[var(--color-muted,#888)]">
        {health.namespace}@{health.serverAddress}
      </span>
      {health.latencyMs !== undefined && (
        <span className="text-xs text-[var(--color-muted,#888)]">
          {health.latencyMs}ms
        </span>
      )}
      <a
        href={uiUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="ml-auto text-xs text-[var(--color-primary,#89b4fa)] hover:underline"
      >
        Temporal UI &#8599;
      </a>
    </div>
  );
}

function WorkflowRow({
  workflow,
  onSignal,
  onTerminate,
  onSelect,
}: {
  readonly workflow: WorkflowSummary;
  readonly onSignal: (id: string) => void;
  readonly onTerminate: (id: string) => void;
  readonly onSelect: (id: string) => void;
}): React.ReactElement {
  const statusColor = STATUS_COLORS[workflow.status] ?? "text-[var(--color-muted,#888)]";
  const duration = workflow.closeTime !== undefined
    ? formatDuration(workflow.closeTime - workflow.startTime)
    : formatDuration(Date.now() - workflow.startTime);

  return (
    <tr
      className="border-b border-[var(--color-border,#333)] hover:bg-[var(--color-card,#313244)] cursor-pointer"
      onClick={() => onSelect(workflow.workflowId)}
    >
      <td className="px-3 py-2 text-xs font-mono text-[var(--color-foreground,#cdd6f4)]">
        {workflow.workflowId}
      </td>
      <td className="px-3 py-2 text-xs text-[var(--color-muted,#888)]">
        {workflow.workflowType}
      </td>
      <td className={`px-3 py-2 text-xs font-medium ${statusColor}`}>
        {workflow.status}
      </td>
      <td className="px-3 py-2 text-xs text-[var(--color-muted,#888)]">
        {duration}
      </td>
      <td className="px-3 py-2 text-xs">
        {workflow.status === "running" && (
          <div className="flex gap-1">
            <button
              type="button"
              className="rounded bg-blue-600/20 px-2 py-0.5 text-xs text-blue-400 hover:bg-blue-600/30"
              onClick={() => onSignal(workflow.workflowId)}
            >
              Signal
            </button>
            <button
              type="button"
              className="rounded bg-red-600/20 px-2 py-0.5 text-xs text-red-400 hover:bg-red-600/30"
              onClick={() => onTerminate(workflow.workflowId)}
            >
              Terminate
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}

export function TemporalTab(): React.ReactElement {
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | undefined>(undefined);

  const { data: health, isLoading: healthLoading } = useRuntimeView<TemporalHealth>(
    "/temporal/health",
    { refetchInterval: 15_000 },
  );
  const { data: workflows, isLoading: wfLoading, refetch } = useRuntimeView<readonly WorkflowSummary[]>(
    "/temporal/workflows",
    { refetchInterval: 5_000 },
  );

  const handleSignal = useCallback((id: string) => {
    // Simple signal with empty payload — a modal could be added later
    void signalWorkflow(id, "refresh", undefined).then(() => refetch());
  }, [refetch]);

  const handleTerminate = useCallback((id: string) => {
    void terminateWorkflow(id).then(() => refetch());
  }, [refetch]);

  const handleSelect = useCallback((id: string) => {
    setSelectedWorkflowId((prev) => (prev === id ? undefined : id));
  }, []);

  if (healthLoading || wfLoading) {
    return <div className="p-4"><LoadingSkeleton /></div>;
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Health */}
      {health !== undefined && <HealthIndicator health={health} />}

      {/* Workflow list */}
      <div className="rounded border border-[var(--color-border,#444)]">
        <table className="w-full">
          <thead>
            <tr className="border-b border-[var(--color-border,#444)] bg-[var(--color-card,#313244)]">
              <th className="px-3 py-2 text-left text-xs font-medium text-[var(--color-muted,#888)]">ID</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-[var(--color-muted,#888)]">Type</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-[var(--color-muted,#888)]">Status</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-[var(--color-muted,#888)]">Duration</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-[var(--color-muted,#888)]">Actions</th>
            </tr>
          </thead>
          <tbody>
            {workflows !== undefined && workflows.length > 0 ? (
              workflows.map((wf) => (
                <WorkflowRow
                  key={wf.workflowId}
                  workflow={wf}
                  onSignal={handleSignal}
                  onTerminate={handleTerminate}
                  onSelect={handleSelect}
                />
              ))
            ) : (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-xs text-[var(--color-muted,#888)]">
                  No workflows
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Workflow detail panel */}
      {selectedWorkflowId !== undefined && (
        <WorkflowDetailPanel
          workflowId={selectedWorkflowId}
          onClose={() => setSelectedWorkflowId(undefined)}
        />
      )}
    </div>
  );
}
