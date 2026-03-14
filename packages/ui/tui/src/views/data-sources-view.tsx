/**
 * Data sources view — shows discovered data sources with status indicators.
 *
 * Renders a selectable list of data sources fetched from the admin API,
 * displaying name, protocol, status, source origin, and detail on select.
 * Navigation: arrow keys / j/k to move, [a] approve, [s] schema, [Esc] back.
 */

import type { DataSourceSummary } from "@koi/dashboard-types";
import { useMemo } from "react";
import { COLORS } from "../theme.js";

export interface DataSourcesViewProps {
  readonly sources: readonly DataSourceSummary[];
  readonly loading: boolean;
  readonly selectedIndex: number;
  readonly onApprove?: ((name: string) => void) | undefined;
  readonly onViewSchema?: ((name: string) => void) | undefined;
  readonly focused: boolean;
}

function statusColor(status: string): string {
  switch (status) {
    case "approved":
      return COLORS.green;
    case "pending":
      return COLORS.yellow;
    case "rejected":
      return COLORS.red;
    default:
      return COLORS.dim;
  }
}

function statusIcon(status: string): string {
  switch (status) {
    case "approved":
      return "\u2713";
    case "pending":
      return "\u25CB";
    case "rejected":
      return "\u2717";
    default:
      return "?";
  }
}

export function DataSourcesView(props: DataSourcesViewProps): React.ReactNode {
  const { sources, loading, selectedIndex, onApprove, onViewSchema } = props;

  const rows = useMemo(
    () =>
      sources.map((s) => ({
        icon: statusIcon(s.status),
        color: statusColor(s.status),
        label: `${s.name} (${s.protocol})`,
        detail: `[${s.status}] from ${s.source}`,
        name: s.name,
        status: s.status,
      })),
    [sources],
  );

  const selected = sources[selectedIndex];

  return (
    <box flexGrow={1} flexDirection="column">
      <box height={1} flexDirection="row">
        <text fg={COLORS.cyan}>
          <b>{" Data Sources"}</b>
        </text>
        <text fg={COLORS.dim}>{` (${String(sources.length)})`}</text>
      </box>

      {loading ? (
        <box flexGrow={1} justifyContent="center" alignItems="center">
          <text fg={COLORS.dim}>{"Loading data sources..."}</text>
        </box>
      ) : sources.length > 0 ? (
        <box flexDirection="column" paddingLeft={1}>
          {rows.map((row, i) => (
            <box key={row.label} height={1} flexDirection="row">
              <text fg={i === selectedIndex ? COLORS.cyan : COLORS.dim}>
                {i === selectedIndex ? "> " : "  "}
              </text>
              <text fg={row.color}>{`${row.icon} `}</text>
              <text {...(i === selectedIndex ? { fg: COLORS.white } : {})}>{row.label}</text>
              <text fg={COLORS.dim}>{`  ${row.detail}`}</text>
            </box>
          ))}

          {/* Detail panel for selected source */}
          {selected !== undefined ? (
            <box flexDirection="column" marginTop={1} paddingLeft={1}>
              <text fg={COLORS.dim}>{"─── Detail ───"}</text>
              <text>{`Name:     ${selected.name}`}</text>
              <text>{`Protocol: ${selected.protocol}`}</text>
              <text>{`Status:   ${selected.status}`}</text>
              <text>{`Source:   ${selected.source}`}</text>
              <box height={1} marginTop={1} flexDirection="row">
                {selected.status === "pending" && onApprove !== undefined ? (
                  <text fg={COLORS.cyan}>{"[a] Approve  "}</text>
                ) : null}
                {onViewSchema !== undefined ? (
                  <text fg={COLORS.cyan}>{"[s] Schema  "}</text>
                ) : null}
                <text fg={COLORS.dim}>{"[Esc] Back"}</text>
              </box>
            </box>
          ) : null}
        </box>
      ) : (
        <box flexGrow={1} justifyContent="center" alignItems="center">
          <text fg={COLORS.dim}>{"No data sources discovered."}</text>
        </box>
      )}
    </box>
  );
}
