/**
 * Nexus browser view — file tree with directory listing and content preview.
 *
 * Shows breadcrumb path, directory entries with selection highlighting,
 * and file content preview when a file is selected.
 */

import { PanelChrome } from "../components/panel-chrome.js";
import type { NexusBrowserState } from "../state/domain-types.js";
import { COLORS } from "../theme.js";

export interface NexusBrowserViewProps {
  readonly nexusBrowser: NexusBrowserState;
  readonly focused: boolean;
  readonly zoomLevel?: "normal" | "half" | "full" | undefined;
}

export function NexusBrowserView(props: NexusBrowserViewProps): React.ReactNode {
  const { entries, path, selectedIndex, fileContent, loading } = props.nexusBrowser;
  const VISIBLE_ROWS = 14;
  const scrollOffset = Math.max(0, selectedIndex - VISIBLE_ROWS + 1);
  const visible = entries.slice(scrollOffset, scrollOffset + VISIBLE_ROWS);

  return (
    <PanelChrome
      title="Nexus Browser"
      count={entries.length}
      focused={props.focused}
      zoomLevel={props.zoomLevel}
      loading={loading}
      loadingMessage="Loading directory…"
      isEmpty={entries.length === 0 && fileContent === null}
      emptyMessage="No data sources connected."
      emptyHint="Run `koi connect gmail` to mount your email."
    >
      {/* Breadcrumb */}
      <box height={1}>
        <text fg={COLORS.cyan}><b>{` ${path}`}</b></text>
      </box>

      {/* Directory listing */}
      <box flexDirection="column">
        <box height={1}>
          <text fg={COLORS.dim}>{" Name                           Size     Modified"}</text>
        </box>
        {visible.map((entry, i) => {
          const actualIdx = scrollOffset + i;
          const isSelected = actualIdx === selectedIndex;
          const icon = entry.isDirectory ? "/" : " ";
          const size = entry.size !== undefined
            ? entry.size < 1024 ? `${String(entry.size)}B` : `${String(Math.round(entry.size / 1024))}K`
            : "-";
          const modified = entry.modifiedAt !== undefined
            ? new Date(entry.modifiedAt).toLocaleTimeString()
            : "-";
          return (
            <box key={entry.path} height={1}>
              <text {...(isSelected ? { fg: COLORS.cyan } : {})}>
                {isSelected ? " >" : "  "}
                {`${icon}${entry.name.padEnd(29).slice(0, 29)} ${size.padEnd(8).slice(0, 8)} ${modified}`}
              </text>
            </box>
          );
        })}
      </box>

      {/* File content preview */}
      {fileContent !== null && (
        <box flexDirection="column" marginTop={1}>
          <box height={1}>
            <text fg={COLORS.green}><b>{" File Preview"}</b></text>
          </box>
          {fileContent.split("\n").filter((l: string) => l.trim() !== "").map((line: string, i: number) => (
            <box key={i} height={1}>
              <text fg={COLORS.dim}>{`   ${line}`}</text>
            </box>
          ))}
        </box>
      )}
    </PanelChrome>
  );
}
