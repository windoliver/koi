/**
 * Handoff view — handoff envelopes table.
 *
 * Shows from -> to handoffs with status, phase progress, and creation time.
 */

import { PanelChrome } from "../components/panel-chrome.js";
import type { HandoffViewState } from "../state/domain-types.js";
import { COLORS } from "../theme.js";

export interface HandoffViewProps {
  readonly handoffView: HandoffViewState;
  readonly focused: boolean;
  readonly zoomLevel?: "normal" | "half" | "full" | undefined;
}

export function HandoffView(props: HandoffViewProps): React.ReactNode {
  const { handoffs, scrollOffset, loading } = props.handoffView;
  const VISIBLE_ROWS = 15;
  const visible = handoffs.slice(scrollOffset, scrollOffset + VISIBLE_ROWS);

  return (
    <PanelChrome
      title="Handoffs"
      count={handoffs.length}
      focused={props.focused}
      zoomLevel={props.zoomLevel}
      loading={loading}
      loadingMessage="Loading handoffs…"
      isEmpty={handoffs.length === 0}
      emptyMessage="No handoff envelopes."
      emptyHint="Handoffs manage agent-to-agent task transitions."
    >
      <box flexDirection="column">
        <box height={1}>
          <text fg={COLORS.dim}>{" From         To           Status       Phase        Created"}</text>
        </box>
        {visible.map((h, i) => {
          const actualIdx = scrollOffset + i;
          const time = new Date(h.createdAt).toLocaleTimeString();
          const phase = `${String(h.phase.completed)}/${h.phase.next}`;
          return (
            <box key={h.id} height={1}>
              <text {...(actualIdx === 0 ? { fg: COLORS.cyan } : {})}>
                {`  ${h.from.padEnd(12).slice(0, 12)} ${h.to.padEnd(12).slice(0, 12)} ${h.status.padEnd(12).slice(0, 12)} ${phase.padEnd(12).slice(0, 12)} ${time}`}
              </text>
            </box>
          );
        })}
      </box>
    </PanelChrome>
  );
}
