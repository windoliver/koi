/**
 * Governance view — pending approval queue, violation log, and sanction levels.
 *
 * Keyboard: [a] approve, [d] deny, [i] inspect, Esc:back.
 * When confirmation is active: [y] confirm, [n] cancel.
 */

import { PanelChrome } from "../components/panel-chrome.js";
import type { GovernanceAgentSanction, GovernanceViewState } from "../state/domain-types.js";
import { COLORS } from "../theme.js";

export interface GovernanceViewProps {
  readonly governanceView: GovernanceViewState;
  readonly focused: boolean;
  readonly zoomLevel?: "normal" | "half" | "full" | undefined;
}

/** Color for a sanction level (0–6). */
function sanctionColor(level: number): string {
  if (level <= 0) return COLORS.green;
  if (level <= 2) return COLORS.yellow;
  if (level <= 4) return COLORS.orange;
  return COLORS.red;
}

/** Human label for a sanction level. */
function sanctionLabel(level: number): string {
  if (level <= 0) return "normal — full autonomy";
  if (level <= 2) return "monitoring — increased oversight";
  if (level <= 4) return "reduced — limited autonomy";
  if (level <= 5) return "suspended";
  return "terminated";
}

/** Render the sanction levels section. */
function SanctionLevelsSection(props: {
  readonly levels: readonly GovernanceAgentSanction[];
}): React.ReactNode {
  if (props.levels.length === 0) return null;
  return (
    <box flexDirection="column" marginTop={1}>
      <box height={1}>
        <text fg={COLORS.dim}>{"────────────────────────────────────────────"}</text>
      </box>
      <box height={1}>
        <text fg={COLORS.cyan}><b>{" SANCTION LEVELS"}</b></text>
      </box>
      {props.levels.map((entry) => {
        const color = sanctionColor(entry.level);
        return (
          <box key={entry.agentId} height={1}>
            <text fg={color}>
              {`   ${entry.agentId.padEnd(18).slice(0, 18)} Level ${String(entry.level)}  ${sanctionLabel(entry.level)}`}
            </text>
          </box>
        );
      })}
    </box>
  );
}

export function GovernanceView(props: GovernanceViewProps): React.ReactNode {
  const { pendingApprovals, violations, scrollOffset, selectedIndex, pendingAction, sanctionLevels } =
    props.governanceView;
  const VISIBLE_ROWS = 10;
  const visibleApprovals = pendingApprovals.slice(scrollOffset, scrollOffset + VISIBLE_ROWS);

  return (
    <PanelChrome
      title="Governance"
      count={pendingApprovals.length}
      focused={props.focused}
      zoomLevel={props.zoomLevel}
      isEmpty={pendingApprovals.length === 0 && violations.length === 0 && sanctionLevels.length === 0}
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

      {/* Confirmation bar */}
      {pendingAction !== null && (
        <box height={1} paddingLeft={1} marginTop={1}>
          <text fg={COLORS.yellow}>
            <b>{` ${pendingAction.kind === "approve" ? "Approve" : "Deny"} ${pendingAction.item.action} for ${pendingAction.item.agentId}? [y/n]`}</b>
          </text>
        </box>
      )}

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

      {/* Sanction levels */}
      <SanctionLevelsSection levels={sanctionLevels} />

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
          {pendingAction !== null ? (
            <>
              <text fg={COLORS.yellow}>{"[y] confirm  "}</text>
              <text fg={COLORS.dim}>{"[n] cancel"}</text>
            </>
          ) : (
            <>
              <text fg={COLORS.green}>{"[a]pprove  "}</text>
              <text fg={COLORS.red}>{"[d]eny  "}</text>
              <text fg={COLORS.dim}>{"Esc:back"}</text>
            </>
          )}
        </box>
      )}
    </PanelChrome>
  );
}
