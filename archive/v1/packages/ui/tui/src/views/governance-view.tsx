/**
 * Governance view — pending approval queue, violation log, and sanction levels.
 *
 * Keyboard: [a] approve, [d] deny, Esc:back.
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
  const VISIBLE_ROWS = 10;
  const visibleApprovals = pendingApprovals.slice(scrollOffset, scrollOffset + VISIBLE_ROWS);

  return (
    <PanelChrome
      title="Governance"
      count={pendingApprovals.length}
      focused={props.focused}
      zoomLevel={props.zoomLevel}
      isEmpty={pendingApprovals.length === 0 && violations.length === 0}
      emptyMessage="All clear — no pending approvals or violations."
      emptyHint="Governance manages approval workflows and policy violations."
    >
      {/* Header summary */}
      <box height={1} flexDirection="row" paddingLeft={1}>
        <text fg={COLORS.white}><b>{"Governance  "}</b></text>
        <text fg={pendingApprovals.length > 0 ? COLORS.yellow : COLORS.dim}>
          {`${String(pendingApprovals.length)} pending`}
        </text>
        <text fg={COLORS.dim}>{"  "}</text>
        <text fg={violations.length > 0 ? COLORS.red : COLORS.dim}>
          {`${String(violations.length)} violations`}
        </text>
      </box>

      {/* Pending approvals — card-style */}
      {pendingApprovals.length > 0 && (
        <box flexDirection="column" marginTop={1}>
          <box height={1}>
            <text fg={COLORS.cyan}><b>{" PENDING APPROVALS"}</b></text>
          </box>
          {visibleApprovals.map((item, i) => {
            const actualIdx = scrollOffset + i;
            const isSelected = actualIdx === selectedIndex;
            const pointer = isSelected ? " \u25B8" : "  ";
            const itemColor = isSelected ? COLORS.cyan : COLORS.white;
            return (
              <box key={item.id} flexDirection="column">
                <box height={1}>
                  <text fg={itemColor}>
                    <b>{`${pointer} \u26A0\uFE0F ${item.agentId} wants ${item.action}`}</b>
                  </text>
                </box>
                {isSelected && (
                  <box flexDirection="column" paddingLeft={4}>
                    <box height={1}>
                      <text fg={COLORS.dim}>{`Resource: ${item.resource}`}</text>
                    </box>
                  </box>
                )}
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

      {/* Keyboard hints */}
      {props.focused && (
        <box height={1} marginTop={1} flexDirection="row" paddingLeft={1}>
          <text fg={COLORS.green}>{"[a]pprove  "}</text>
          <text fg={COLORS.red}>{"[d]eny  "}</text>
          <text fg={COLORS.dim}>{"Esc:back"}</text>
        </box>
      )}
    </PanelChrome>
  );
}
