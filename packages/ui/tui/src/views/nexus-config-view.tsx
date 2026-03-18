/**
 * Nexus config view — Nexus setup during the welcome wizard flow.
 *
 * Options: Docker (default), build from source, remote URL, or skip.
 */

import type { NexusConfigMode } from "../state/types.js";
import { NEXUS_CONFIG_OPTIONS } from "../state/types.js";
import { COLORS } from "../theme.js";

export interface NexusConfigViewProps {
  readonly focusedIndex: number;
  readonly selectedMode: NexusConfigMode;
  readonly sourcePath: string;
  readonly remoteUrl: string;
}

export function NexusConfigView(props: NexusConfigViewProps): React.ReactNode {
  const { focusedIndex, selectedMode, sourcePath, remoteUrl } = props;

  return (
    <box flexGrow={1} flexDirection="column" paddingLeft={2} paddingTop={1}>
      <text fg={COLORS.cyan}><b>{"  Nexus Configuration"}</b></text>
      <text fg={COLORS.dim}>
        {"  Nexus is the shared backend for data, auth, and coordination."}
      </text>

      <box marginTop={1} flexDirection="column" paddingLeft={2}>
        {NEXUS_CONFIG_OPTIONS.map((opt, i) => {
          const isFocused = i === focusedIndex;
          const isSelected = opt.id === selectedMode;
          const indicator = isSelected ? "●" : "○";
          return (
            <box key={opt.id} height={1} flexDirection="row">
              <text fg={isFocused ? COLORS.cyan : COLORS.dim}>
                {isFocused ? " > " : "   "}
              </text>
              <text fg={isSelected ? COLORS.green : COLORS.dim}>{`${indicator} `}</text>
              <text fg={isFocused ? COLORS.white : COLORS.dim}>
                {opt.label.padEnd(20)}
              </text>
              <text fg={COLORS.dim}>{opt.description}</text>
            </box>
          );
        })}
      </box>

      {selectedMode === "source" && (
        <box marginTop={1} paddingLeft={4} flexDirection="column">
          <text fg={COLORS.white}>{`  Source path: ${sourcePath}`}</text>
          <text fg={COLORS.dim}>{"  (set via --nexus-source flag)"}</text>
        </box>
      )}

      {selectedMode === "remote" && (
        <box marginTop={1} paddingLeft={4} flexDirection="column">
          <text fg={COLORS.white}>{`  Remote URL: ${remoteUrl || "(not set)"}`}</text>
          <text fg={COLORS.dim}>{"  (set NEXUS_URL in .env)"}</text>
        </box>
      )}

      <box marginTop={2} paddingLeft={2}>
        <text fg={COLORS.dim}>
          {"  j/k:navigate  Enter:select & continue  Esc:back"}
        </text>
      </box>
    </box>
  );
}
