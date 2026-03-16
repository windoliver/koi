/**
 * Progress view — renders phase progress during `koi up`.
 *
 * Shows status symbols: ◌ pending, ● running (cyan), ✓ done (green), ✕ failed (red).
 */

import type { PhaseProgress } from "@koi/setup-core";
import { COLORS } from "../theme.js";

export interface ProgressViewProps {
  readonly phases: readonly PhaseProgress[];
  readonly setupRunning: boolean;
  readonly focused?: boolean | undefined;
}

function statusSymbol(status: PhaseProgress["status"]): string {
  switch (status) {
    case "pending": return "◌";
    case "running": return "●";
    case "done": return "✓";
    case "failed": return "✕";
  }
}

function statusColor(status: PhaseProgress["status"]): string {
  switch (status) {
    case "pending": return COLORS.dim;
    case "running": return COLORS.cyan;
    case "done": return COLORS.green;
    case "failed": return COLORS.red;
  }
}

/** Progress view for setup phases. */
export function ProgressView(props: ProgressViewProps): React.ReactNode {
  const { phases, setupRunning } = props;
  const failedPhase = phases.find((p) => p.status === "failed");

  return (
    <box flexGrow={1} flexDirection="column" paddingLeft={2} paddingTop={1}>
      <text fg={COLORS.cyan}>
        <b>{setupRunning ? "  Starting Koi..." : "  Setup Complete"}</b>
      </text>

      <box marginTop={1} paddingLeft={2} flexDirection="column">
        {phases.map((phase) => (
          <box key={phase.phaseId} height={1} flexDirection="row">
            <text fg={statusColor(phase.status)}>
              {`  ${statusSymbol(phase.status)} `}
            </text>
            <text fg={phase.status === "running" ? COLORS.white : COLORS.dim}>
              {phase.label}
            </text>
            {phase.message !== undefined && phase.status === "running" && (
              <text fg={COLORS.dim}>{` — ${phase.message}`}</text>
            )}
          </box>
        ))}
      </box>

      {failedPhase !== undefined && (
        <box marginTop={1} paddingLeft={2} flexDirection="column">
          <text fg={COLORS.red}>
            <b>{`  Error in "${failedPhase.label}":`}</b>
          </text>
          {failedPhase.error !== undefined && (
            <text fg={COLORS.red}>{`    ${failedPhase.error}`}</text>
          )}
        </box>
      )}

      {!setupRunning && failedPhase === undefined && (
        <box marginTop={1} paddingLeft={2}>
          <text fg={COLORS.green}>{"  All phases complete. Transitioning to boardroom..."}</text>
        </box>
      )}
    </box>
  );
}
