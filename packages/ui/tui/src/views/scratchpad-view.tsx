/**
 * Scratchpad view — group-scoped shared memory browser.
 *
 * Shows file list with path, author, group, size, and update time.
 * When an entry is selected, shows content preview below.
 */

import { PanelChrome } from "../components/panel-chrome.js";
import type { ScratchpadViewState } from "../state/domain-types.js";
import { COLORS } from "../theme.js";

export interface ScratchpadViewProps {
  readonly scratchpadView: ScratchpadViewState;
  readonly focused: boolean;
  readonly zoomLevel?: "normal" | "half" | "full" | undefined;
}

export function ScratchpadView(props: ScratchpadViewProps): React.ReactNode {
  const { entries, selectedEntry, scrollOffset, loading } = props.scratchpadView;
  const VISIBLE_ROWS = 12;
  const visible = entries.slice(scrollOffset, scrollOffset + VISIBLE_ROWS);

  return (
    <PanelChrome
      title="Scratchpad"
      count={entries.length}
      focused={props.focused}
      zoomLevel={props.zoomLevel}
      loading={loading}
      loadingMessage="Loading scratchpad…"
      isEmpty={entries.length === 0}
      emptyMessage="No scratchpad entries."
      emptyHint="Scratchpad provides group-scoped shared memory for agents."
    >
      <box flexDirection="column">
        <box height={1}>
          <text fg={COLORS.dim}>{" Path                 Author       Group        Size     Updated"}</text>
        </box>
        {visible.map((entry) => {
          const time = new Date(entry.updatedAt).toLocaleTimeString();
          const size = entry.sizeBytes < 1024
            ? `${String(entry.sizeBytes)}B`
            : `${String(Math.round(entry.sizeBytes / 1024))}K`;
          return (
            <box key={entry.path} height={1}>
              <text>
                {`  ${entry.path.padEnd(20).slice(0, 20)} ${entry.authorId.padEnd(12).slice(0, 12)} ${entry.groupId.padEnd(12).slice(0, 12)} ${size.padEnd(8).slice(0, 8)} ${time}`}
              </text>
            </box>
          );
        })}
      </box>

      {/* Content preview for selected entry */}
      {selectedEntry !== null && (
        <box flexDirection="column" marginTop={1}>
          <box height={1}>
            <text fg={COLORS.cyan}><b>{` Preview: ${selectedEntry.path}`}</b></text>
          </box>
          <box height={1}>
            <text fg={COLORS.dim}>{`   gen=${String(selectedEntry.generation)}  ${String(selectedEntry.sizeBytes)} bytes`}</text>
          </box>
          {selectedEntry.content.split("\n").slice(0, 6).map((line: string, i: number) => (
            <box key={i} height={1}>
              <text fg={COLORS.dim}>{`   ${line.slice(0, 72)}`}</text>
            </box>
          ))}
        </box>
      )}
    </PanelChrome>
  );
}
