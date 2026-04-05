/**
 * DoctorView — "doctor" screen (activeView === "doctor").
 *
 * Shows environment diagnostics: connection status, model/provider, TTY detection.
 * Read-only display — no interactive elements.
 */

import type { JSX } from "solid-js";
import { useTuiStore } from "../store-context.js";
import { COLORS, CONNECTION_STATUS_CONFIG } from "../theme.js";

export function DoctorView(): JSX.Element {
  const connectionStatus = useTuiStore((s) => s.connectionStatus);
  const sessionInfo = useTuiStore((s) => s.sessionInfo);

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={2} paddingRight={2} paddingTop={1}>
      <text fg={COLORS.cyan}>{"System Health"}</text>
      <text>{" "}</text>
      <box flexDirection="row" gap={1}>
        <text fg={COLORS.dim}>{"Connection".padEnd(14)}</text>
        <text fg={CONNECTION_STATUS_CONFIG[connectionStatus()].color}>
          {CONNECTION_STATUS_CONFIG[connectionStatus()].indicator}
        </text>
      </box>
      <box flexDirection="row" gap={1}>
        <text fg={COLORS.dim}>{"TTY".padEnd(14)}</text>
        <text fg={COLORS.green}>{"✓ detected"}</text>
      </box>
      <box flexDirection="row" gap={1}>
        <text fg={COLORS.dim}>{"Model".padEnd(14)}</text>
        <text fg={sessionInfo() ? COLORS.white : COLORS.dim}>
          {sessionInfo()?.modelName ?? "—"}
        </text>
      </box>
      <box flexDirection="row" gap={1}>
        <text fg={COLORS.dim}>{"Provider".padEnd(14)}</text>
        <text fg={sessionInfo() ? COLORS.white : COLORS.dim}>
          {sessionInfo()?.provider ?? "—"}
        </text>
      </box>
    </box>
  );
}
