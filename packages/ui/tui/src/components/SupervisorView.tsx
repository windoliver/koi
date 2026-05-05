/**
 * SupervisorView — full-screen `/supervisor` view (#1944).
 *
 * Read-only display of the SupervisorSlice. Four sections:
 *   - Status banner  — live/degraded/stale indicator
 *   - Health header  — ok/degraded/unhealthy + reasons list
 *   - Metrics row    — poolSize, maxWorkers, quarantined, restarting, etc.
 *   - Worker table   — per-worker id/state/heartbeat columns
 *   - Event feed     — last 50 events newest-first
 *
 * No interaction beyond Esc (handled by TuiRoot's global key handler).
 */

import { For, Show, type Component } from "solid-js";
import type { SupervisorHealth, SupervisorHealthMetrics, WorkerHealth } from "@koi/core/daemon";
import type { BridgeStatus, SupervisorEventEntry, SupervisorSlice } from "../state/types.js";
import { COLORS } from "../theme.js";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const COL_WORKER = 24;
const COL_AGENT = 24;
const COL_STATE = 14;
const COL_HB = 18;
const MAX_EVENTS = 50;

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Returns a color + text object for the status banner, or null for "live"
 * and "detached" (no banner needed).
 */
export function formatStatusBanner(
  status: BridgeStatus,
  now: number,
): { readonly color: string; readonly text: string } | null {
  if (status.kind === "live" || status.kind === "detached") return null;
  if (status.kind === "degraded") {
    const secs = Math.round((now - status.since) / 1000);
    const channels = status.missing.join(", ");
    return { color: COLORS.amber, text: `Push channel down: ${channels} (${secs}s ago)` };
  }
  // stale
  const secs = Math.round((now - status.since) / 1000);
  return {
    color: COLORS.red,
    text: `Observability stale (${status.reason}) — last snapshot kept (${secs}s ago)`,
  };
}

/** One-line metrics summary string. */
export function formatMetricsRow(metrics: SupervisorHealthMetrics): string {
  const sd = metrics.shuttingDown ? "yes" : "no";
  return (
    `${metrics.poolSize}/${metrics.maxWorkers} workers` +
    ` · quarantined: ${metrics.quarantinedCount}` +
    ` · restarting: ${metrics.restartingCount}` +
    ` · pendingSpawn: ${metrics.pendingSpawnCount}` +
    ` · eventDrops: ${metrics.eventDropCount}` +
    ` · shuttingDown: ${sd}`
  );
}

/** Format a worker row for the table. */
export function formatWorkerRow(
  w: WorkerHealth,
  now: number,
): {
  readonly workerId: string;
  readonly agentId: string;
  readonly state: string;
  readonly lastHb: string;
  readonly deadline: string;
} {
  const age = (ts: number | undefined): string => {
    if (ts === undefined) return "—";
    const diffMs = now - ts;
    if (diffMs >= 1000) return `${(diffMs / 1000).toFixed(1)}s ago`;
    return `${diffMs}ms ago`;
  };
  return {
    workerId: w.workerId,
    agentId: w.agentId,
    state: w.state,
    lastHb: age(w.lastHeartbeatAt),
    deadline: age(w.heartbeatDeadlineAt),
  };
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function pad(s: string, w: number): string {
  if (s.length >= w) return `${s.slice(0, Math.max(0, w - 1))} `;
  return s + " ".repeat(w - s.length);
}

const SectionHeader: Component<{ readonly title: string }> = (p) => (
  <box marginTop={1}>
    <text fg={COLORS.accent}>{p.title}</text>
  </box>
);

const WorkerTableHeader: Component = () => (
  <text fg={COLORS.textMuted}>
    {pad("workerId", COL_WORKER) +
      pad("agentId", COL_AGENT) +
      pad("state", COL_STATE) +
      pad("lastHeartbeatAt", COL_HB) +
      "heartbeatDeadlineAt"}
  </text>
);

// ---------------------------------------------------------------------------
// Props + component
// ---------------------------------------------------------------------------

export interface SupervisorViewProps {
  readonly slice: SupervisorSlice;
}

export const SupervisorView: Component<SupervisorViewProps> = (props) => {
  const now = (): number => Date.now();
  const banner = (): { readonly color: string; readonly text: string } | null =>
    formatStatusBanner(props.slice.status, now());

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={2} paddingRight={2} paddingTop={1}>
      <text fg={COLORS.accent}>{"Supervisor"}</text>

      <Show when={!props.slice.attached}>
        <box paddingTop={1}>
          <text fg={COLORS.textMuted}>
            {
              "No supervisor attached. Start a manifest with `supervision:` containing a subprocess child."
            }
          </text>
        </box>
      </Show>

      <Show when={props.slice.attached}>
        {/* Status banner — only shown for degraded/stale */}
        <Show when={banner()}>
          {(b: () => { readonly color: string; readonly text: string }) => (
            <text fg={b().color}>{b().text}</text>
          )}
        </Show>

        <Show
          when={props.slice.health !== null}
          fallback={
            <box flexDirection="column" paddingTop={1}>
              <text fg={COLORS.textMuted}>{"Loading…"}</text>
            </box>
          }
        >
          <HealthSection health={props.slice.health as SupervisorHealth} />
        </Show>

        <SectionHeader title="Events" />
        <Show
          when={props.slice.events.length > 0}
          fallback={<text fg={COLORS.textMuted}>{"No events yet"}</text>}
        >
          <EventFeed events={props.slice.events} />
        </Show>
      </Show>

      <text fg={COLORS.textMuted}>{"Esc to close"}</text>
    </box>
  );
};

// ---------------------------------------------------------------------------
// Health section (only rendered when health !== null)
// ---------------------------------------------------------------------------

const HealthSection: Component<{ readonly health: SupervisorHealth }> = (p) => {
  const statusColor = (): string => {
    switch (p.health.status) {
      case "ok":
        return COLORS.green;
      case "degraded":
        return COLORS.amber;
      case "unhealthy":
        return COLORS.red;
    }
  };

  return (
    <box flexDirection="column">
      <SectionHeader title="Health" />
      <box flexDirection="row" gap={1}>
        <text fg={statusColor()}>{p.health.status}</text>
      </box>

      <Show when={p.health.reasons.length > 0}>
        <box flexDirection="column" paddingLeft={2}>
          <For each={p.health.reasons}>
            {(reason) => <text fg={COLORS.textSecondary}>{`• ${reason}`}</text>}
          </For>
        </box>
      </Show>

      <SectionHeader title="Metrics" />
      <text fg={COLORS.textSecondary}>{formatMetricsRow(p.health.metrics)}</text>

      <SectionHeader title="Workers" />
      <Show
        when={p.health.workers.length > 0}
        fallback={<text fg={COLORS.textMuted}>{"No workers"}</text>}
      >
        <box flexDirection="column">
          <WorkerTableHeader />
          <For each={p.health.workers}>
            {(w: WorkerHealth) => {
              const row = formatWorkerRow(w, Date.now());
              return (
                <text>
                  {pad(row.workerId, COL_WORKER) +
                    pad(row.agentId, COL_AGENT) +
                    pad(row.state, COL_STATE) +
                    pad(row.lastHb, COL_HB) +
                    row.deadline}
                </text>
              );
            }}
          </For>
        </box>
      </Show>
    </box>
  );
};

// ---------------------------------------------------------------------------
// Event feed — last MAX_EVENTS entries, newest first
// ---------------------------------------------------------------------------

function timeAgo(ts: number, now: number): string {
  const diffMs = now - ts;
  if (diffMs >= 60_000) return `${Math.round(diffMs / 60_000)}m ago`;
  if (diffMs >= 1000) return `${(diffMs / 1000).toFixed(0)}s ago`;
  return `${diffMs}ms ago`;
}

const EventFeed: Component<{ readonly events: readonly SupervisorEventEntry[] }> = (p) => {
  const now = Date.now();
  const recent = (): readonly SupervisorEventEntry[] =>
    p.events.slice(-MAX_EVENTS).slice().reverse();

  return (
    <box flexDirection="column">
      <For each={recent()}>
        {(e: SupervisorEventEntry) => {
          const detail = e.detail !== undefined ? ` — ${e.detail}` : "";
          const line = `${timeAgo(e.ts, now)} ${e.kind} ${e.workerId} ${e.agentName}${detail}`;
          return <text fg={COLORS.textSecondary}>{line}</text>;
        }}
      </For>
    </box>
  );
};
