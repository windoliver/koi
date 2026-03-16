/**
 * Governance view — pending approval queue + violation log.
 *
 * Keyboard: [a] approve, [d] deny, [m] modify.
 */

import { PanelChrome } from "../components/panel-chrome.js";
import type { GovernanceViewState } from "../state/domain-types.js";
import { COLORS } from "../theme.js";

export interface GovernanceViewProps {
  readonly governanceView: GovernanceViewState;
  readonly focused: boolean;
  readonly zoomLevel?: "normal" | "half" | "full" | undefined;
}

export function GovernanceView(props: GovernanceViewProps): React.ReactNode {
  const { pendingApprovals, violations, scrollOffset, selectedIndex } = props.governanceView;
  const VISIBLE_ROWS = 15;
  const visibleApprovals = pendingApprovals.slice(scrollOffset, scrollOffset + VISIBLE_ROWS);

  return (
    <PanelChrome
      title="Governance"
      count={pendingApprovals.length}
      focused={props.focused}
      zoomLevel={props.zoomLevel}
      isEmpty={pendingApprovals.length === 0 && violations.length === 0}
      emptyMessage="No governance items."
      emptyHint="Governance manages approval workflows and policy violations."
    >
      {/* Pending approvals */}
      {pendingApprovals.length > 0 && (
        <box flexDirection="column">
          <box height={1}>
            <text fg={COLORS.cyan}><b>{` Pending Approvals (${String(pendingApprovals.length)})`}</b></text>
          </box>
          <box height={1}>
            <text fg={COLORS.dim}>{" Agent        Action           Resource             Time"}</text>
          </box>
          {visibleApprovals.map((item, i) => {
            const actualIdx = scrollOffset + i;
            const isSelected = actualIdx === selectedIndex;
            const time = new Date(item.timestamp).toLocaleTimeString();
            return (
              <box key={item.id} height={1}>
                <text fg={isSelected ? COLORS.cyan : undefined}>
                  {isSelected ? " >" : "  "}
                  {`${item.agentId.padEnd(12).slice(0, 12)} ${item.action.padEnd(16).slice(0, 16)} ${item.resource.padEnd(20).slice(0, 20)} ${time}`}
                </text>
              </box>
            );
          })}
        </box>
      )}

      {/* Violation log */}
      {violations.length > 0 && (
        <box flexDirection="column" marginTop={1}>
          <box height={1}>
            <text fg={COLORS.red}><b>{` Violations (${String(violations.length)})`}</b></text>
          </box>
          {violations.slice(-10).map((v) => {
            const time = new Date(v.timestamp).toLocaleTimeString();
            return (
              <box key={v.id} height={1}>
                <text fg={COLORS.dim}>
                  {`   ${time} ${v.agentId.padEnd(12).slice(0, 12)} ${v.rule.padEnd(16).slice(0, 16)} ${v.action}`}
                </text>
              </box>
            );
          })}
        </box>
      )}
    </PanelChrome>
  );
}
