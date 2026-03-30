/**
 * Nexus browser view — file tree with directory listing and content preview.
 *
 * Shows breadcrumb path, directory entries with selection highlighting,
 * and scrollable file content preview when a file is selected.
 */

import { PanelChrome } from "../components/panel-chrome.js";
import type { NexusBrowserState } from "../state/domain-types.js";
import { COLORS } from "../theme.js";

/** Pretty-print JSON content for the file preview. Falls back to raw lines. */
function formatPreview(raw: string): readonly string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const pretty = JSON.stringify(parsed, null, 2);
    return pretty.split("\n");
  } catch {
    // Not JSON — show raw lines
    return raw.split("\n").filter((l: string) => l.trim() !== "");
  }
}

export interface NexusBrowserViewProps {
  readonly nexusBrowser: NexusBrowserState;
  readonly focused: boolean;
  readonly zoomLevel?: "normal" | "half" | "full" | undefined;
}

export function NexusBrowserView(props: NexusBrowserViewProps): React.ReactNode {
  const { entries, path, selectedIndex, fileContent, loading } = props.nexusBrowser;
  const previewScrollOffset = (props.nexusBrowser as { readonly previewScrollOffset?: number }).previewScrollOffset ?? 0;

  // When a file is selected, shrink the directory listing to make room for preview
  const hasPreview = fileContent !== null;
  const DIRECTORY_ROWS = hasPreview ? 6 : 14;
  const dirScrollOffset = Math.max(0, selectedIndex - DIRECTORY_ROWS + 1);
  const visibleEntries = entries.slice(dirScrollOffset, dirScrollOffset + DIRECTORY_ROWS);

  // Preview gets remaining space — show as many lines as the terminal allows
  const PREVIEW_VISIBLE = hasPreview ? 30 : 0;
  const previewLines = hasPreview ? formatPreview(fileContent) : [];
  const visiblePreview = previewLines.slice(previewScrollOffset, previewScrollOffset + PREVIEW_VISIBLE);
  const previewTotal = previewLines.length;

  return (
    <PanelChrome
      title="Nexus Browser"
      count={entries.length}
      focused={props.focused}
      zoomLevel={props.zoomLevel}
      loading={loading}
      loadingMessage="Loading directory…"
      isEmpty={entries.length === 0 && fileContent === null}
      emptyMessage={path === "/" ? "No data sources connected." : "Empty directory."}
      emptyHint={path === "/" ? "Run `koi connect` to mount a data source." : "Navigate with arrow keys. Enter to open."}
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
        {visibleEntries.map((entry, i) => {
          const actualIdx = dirScrollOffset + i;
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

      {/* File content preview with scroll indicator */}
      {hasPreview && (
        <box flexDirection="column" marginTop={1}>
          <box height={1}>
            <text fg={COLORS.green}>
              <b>{` File Preview`}</b>
              {previewTotal > PREVIEW_VISIBLE
                ? ` (${String(previewScrollOffset + 1)}-${String(Math.min(previewScrollOffset + PREVIEW_VISIBLE, previewTotal))} of ${String(previewTotal)} lines)`
                : ` (${String(previewTotal)} lines)`}
            </text>
          </box>
          {visiblePreview.map((line: string, i: number) => (
            <box key={i} height={1}>
              <text fg={COLORS.dim}>{`   ${line}`}</text>
            </box>
          ))}
        </box>
      )}
    </PanelChrome>
  );
}
