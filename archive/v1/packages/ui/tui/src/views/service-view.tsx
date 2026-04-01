/**
 * Service view — shows subsystem status and service management controls.
 *
 * Status indicators: ● ready (green), ○ not_running (dim), ⚠ degraded (yellow).
 */

import type { ServiceStatusState } from "../state/types.js";
import { COLORS } from "../theme.js";

/** Demo pack summary for display. */
export interface DemoPackEntry {
  readonly id: string;
  readonly description: string;
}

export interface ServiceViewProps {
  readonly status: ServiceStatusState | null;
  readonly focused?: boolean | undefined;
  readonly demoPacks?: readonly DemoPackEntry[] | undefined;
  readonly pendingStopConfirm?: boolean | undefined;
}

function subsystemIndicator(status: string): { readonly symbol: string; readonly color: string } {
  switch (status) {
    case "ready": return { symbol: "●", color: COLORS.green };
    case "degraded": return { symbol: "⚠", color: COLORS.yellow };
    default: return { symbol: "○", color: COLORS.dim };
  }
}

/** Service status and management view. */
export function ServiceView(props: ServiceViewProps): React.ReactNode {
  const { status, demoPacks, pendingStopConfirm } = props;

  if (status === null) {
    return (
      <box flexGrow={1} flexDirection="column" paddingLeft={2} paddingTop={1}>
        <text fg={COLORS.cyan}><b>{"  Service Status"}</b></text>
        <box marginTop={1} paddingLeft={2}>
          <text fg={COLORS.dim}>{"  Loading status..."}</text>
        </box>
      </box>
    );
  }

  const uptimeSeconds = Math.floor(status.uptimeMs / 1000);
  const uptimeMin = Math.floor(uptimeSeconds / 60);
  const uptimeLabel = uptimeMin > 0
    ? `${String(uptimeMin)}m ${String(uptimeSeconds % 60)}s`
    : `${String(uptimeSeconds)}s`;

  return (
    <box flexGrow={1} flexDirection="column" paddingLeft={2} paddingTop={1}>
      <text fg={COLORS.cyan}><b>{"  Service Status"}</b></text>
      <text fg={COLORS.dim}>{`  Uptime: ${uptimeLabel}`}</text>

      <box marginTop={1} paddingLeft={2} flexDirection="column">
        <text fg={COLORS.white}><b>{"  Subsystems"}</b></text>
        {Object.entries(status.subsystems).map(([name, sub]) => {
          const ind = subsystemIndicator(sub.status);
          const latencyLabel = sub.latencyMs !== undefined ? ` (${String(sub.latencyMs)}ms)` : "";
          return (
            <box key={name} height={1} flexDirection="row">
              <text fg={ind.color}>{`    ${ind.symbol} `}</text>
              <text fg={COLORS.white}>{name.padEnd(12)}</text>
              <text fg={COLORS.dim}>{`${sub.status}${latencyLabel}`}</text>
            </box>
          );
        })}
      </box>

      {status.ports.length > 0 && (
        <box marginTop={1} paddingLeft={2} flexDirection="column">
          <text fg={COLORS.white}><b>{"  Ports"}</b></text>
          {status.ports.map((p) => (
            <box key={p.port} height={1} flexDirection="row">
              <text fg={p.status === "listening" ? COLORS.green : COLORS.dim}>
                {`    ${p.status === "listening" ? "●" : "○"} `}
              </text>
              <text fg={COLORS.white}>{`${String(p.port).padEnd(8)}`}</text>
              <text fg={COLORS.dim}>{`${p.service} (${p.status})`}</text>
            </box>
          ))}
        </box>
      )}

      {demoPacks !== undefined && demoPacks.length > 0 && (
        <box marginTop={1} paddingLeft={2} flexDirection="column">
          <text fg={COLORS.white}><b>{"  Demo Packs"}</b></text>
          {demoPacks.map((p) => (
            <box key={p.id} height={1} flexDirection="row">
              <text fg={COLORS.cyan}>{`    ${p.id.padEnd(16)}`}</text>
              <text fg={COLORS.dim}>{p.description}</text>
            </box>
          ))}
        </box>
      )}

      {pendingStopConfirm === true && (
        <box marginTop={1} paddingLeft={2}>
          <text fg={COLORS.yellow}><b>{"  ⚠ Press /stop again to confirm shutdown"}</b></text>
        </box>
      )}

      <box marginTop={1} paddingLeft={2}>
        <text fg={COLORS.dim}>{"  s:stop  d:doctor  l:logs  Esc:back"}</text>
      </box>
    </box>
  );
}
