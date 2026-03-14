/**
 * Data sources view — shows discovered data sources with status indicators.
 *
 * Renders a list of data sources fetched from the admin API,
 * displaying name, protocol, status, and source origin.
 */

import type { DataSourceSummary } from "@koi/dashboard-types";
import { useMemo } from "react";
import { COLORS } from "../theme.js";

export interface DataSourcesViewProps {
  readonly sources: readonly DataSourceSummary[];
  readonly loading: boolean;
  readonly onApprove?: ((name: string) => void) | undefined;
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
  const { sources, loading } = props;

  const rows = useMemo(
    () =>
      sources.map((s) => ({
        icon: statusIcon(s.status),
        color: statusColor(s.status),
        label: `${s.name} (${s.protocol})`,
        detail: `[${s.status}] from ${s.source}`,
      })),
    [sources],
  );

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
          {rows.map((row) => (
            <box key={row.label} height={1} flexDirection="row">
              <text fg={row.color}>{`${row.icon} `}</text>
              <text>{row.label}</text>
              <text fg={COLORS.dim}>{`  ${row.detail}`}</text>
            </box>
          ))}
        </box>
      ) : (
        <box flexGrow={1} justifyContent="center" alignItems="center">
          <text fg={COLORS.dim}>{"No data sources discovered."}</text>
        </box>
      )}
    </box>
  );
}
