/**
 * Delegation view — delegation grants table.
 *
 * Shows issuer -> delegatee grants with scope, expiry, and chain depth.
 */

import { PanelChrome } from "../components/panel-chrome.js";
import type { DelegationViewState } from "../state/domain-types.js";
import { COLORS } from "../theme.js";

export interface DelegationViewProps {
  readonly delegationView: DelegationViewState;
  readonly focused: boolean;
  readonly zoomLevel?: "normal" | "half" | "full" | undefined;
}

export function DelegationView(props: DelegationViewProps): React.ReactNode {
  const { delegations, scrollOffset, loading } = props.delegationView;
  const VISIBLE_ROWS = 15;
  const visible = delegations.slice(scrollOffset, scrollOffset + VISIBLE_ROWS);

  return (
    <PanelChrome
      title="Delegation"
      count={delegations.length}
      focused={props.focused}
      zoomLevel={props.zoomLevel}
      loading={loading}
      loadingMessage="Loading delegations…"
      isEmpty={delegations.length === 0}
      emptyMessage="No delegation grants."
      emptyHint="Delegation manages authority grants between agents."
    >
      <box flexDirection="column">
        <box height={1}>
          <text fg={COLORS.dim}>{" Issuer       Delegatee    Scope            Expiry               Depth"}</text>
        </box>
        {visible.map((d, i) => {
          const actualIdx = scrollOffset + i;
          const expiry = d.expiresAt !== null
            ? new Date(d.expiresAt).toLocaleTimeString()
            : "never";
          return (
            <box key={d.id} height={1}>
              <text {...(actualIdx === 0 ? { fg: COLORS.cyan } : {})}>
                {`  ${d.issuerId.padEnd(12).slice(0, 12)} ${d.delegateeId.padEnd(12).slice(0, 12)} ${d.scope.padEnd(16).slice(0, 16)} ${expiry.padEnd(20).slice(0, 20)} ${String(d.chainDepth)}`}
              </text>
            </box>
          );
        })}
      </box>
    </PanelChrome>
  );
}
