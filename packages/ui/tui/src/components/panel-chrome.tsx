/**
 * PanelChrome — reusable wrapper that provides border, header, focus
 * indicator, loading spinner, and empty-state pattern for all TUI panels.
 */

import type { ReactNode } from "react";
import { COLORS } from "../theme.js";

/** Props for the PanelChrome component. */
export interface PanelChromeProps {
  readonly title: string;
  readonly count?: number | undefined;
  readonly focused: boolean;
  readonly loading?: boolean | undefined;
  readonly loadingMessage?: string | undefined;
  readonly emptyMessage?: string | undefined;
  readonly emptyHint?: string | undefined;
  readonly isEmpty?: boolean | undefined;
  readonly zoomLevel?: "normal" | "half" | "full" | undefined;
  /** Error message — when set, renders error state with optional retry. */
  readonly error?: string | undefined;
  /** Retry callback — shown as [r] retry when error is set. */
  readonly onRetry?: (() => void) | undefined;
  /** Epoch timestamp of last successful data fetch — shows staleness. */
  readonly lastUpdated?: number | undefined;
  readonly children: ReactNode;
}

/** Compute flex sizing from zoom level. */
function flexFromZoom(zoom: "normal" | "half" | "full" | undefined): number {
  switch (zoom) {
    case "full":
      return 3;
    case "half":
      return 2;
    default:
      return 1;
  }
}

/** Centered placeholder used for loading and empty states. */
function CenteredPlaceholder(props: {
  readonly message: string;
  readonly hint?: string | undefined;
  readonly messageColor: string;
}): ReactNode {
  return (
    <box flexGrow={1} justifyContent="center" alignItems="center" flexDirection="column">
      <text fg={props.messageColor}>{props.message}</text>
      {props.hint !== undefined && (
        <text fg={COLORS.cyan}>{props.hint}</text>
      )}
    </box>
  );
}

/** Reusable panel wrapper with border, header, focus, loading, and empty states. */
export function PanelChrome(props: PanelChromeProps): ReactNode {
  const borderColor = props.focused ? COLORS.cyan : COLORS.dim;
  const flexGrow = flexFromZoom(props.zoomLevel);

  return (
    <box
      flexGrow={flexGrow}
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={borderColor}
    >
      {/* Title bar */}
      <box height={1} flexDirection="row">
        <text fg={COLORS.accent}>
          <b>{` ${props.title}`}</b>
        </text>
        {props.count !== undefined && (
          <text fg={COLORS.dim}>{` (${String(props.count)})`}</text>
        )}
        {props.lastUpdated !== undefined && (() => {
          const ago = Math.floor((Date.now() - props.lastUpdated) / 1000);
          if (ago > 60) {
            const mins = Math.floor(ago / 60);
            return <text fg={COLORS.yellow}>{` · ${String(mins)}m ago`}</text>;
          }
          return null;
        })()}
        {props.error !== undefined && (
          <text fg={COLORS.red}>{" · error"}</text>
        )}
      </box>

      {/* Content area */}
      {props.error !== undefined ? (
        <CenteredPlaceholder
          message={`✘ ${props.error}`}
          hint={props.onRetry !== undefined ? "[r] retry    [Esc] back" : "[Esc] back"}
          messageColor={COLORS.red}
        />
      ) : props.loading === true ? (
        <CenteredPlaceholder
          message={props.loadingMessage ?? "Loading…"}
          messageColor={COLORS.dim}
        />
      ) : props.isEmpty === true && props.emptyMessage !== undefined ? (
        <CenteredPlaceholder
          message={props.emptyMessage}
          hint={props.emptyHint}
          messageColor={COLORS.dim}
        />
      ) : (
        <box flexGrow={1} flexDirection="column">
          {props.children}
        </box>
      )}
    </box>
  );
}
