/**
 * Consent view — mid-session prompt for newly discovered data sources.
 *
 * Shows pending source(s) with name/protocol/origin and keyboard shortcuts
 * for approve, deny, details, or dismiss.
 */

import type { DataSourceSummary } from "@koi/dashboard-types";
import { PanelChrome } from "../components/panel-chrome.js";
import { COLORS } from "../theme.js";

export interface ConsentViewProps {
  readonly sources: readonly DataSourceSummary[];
  readonly onApprove: (name: string) => void;
  readonly onDeny: (name: string) => void;
  readonly onDetails: (name: string) => void;
  readonly onDismiss: () => void;
  readonly focused: boolean;
}

export function ConsentView(props: ConsentViewProps): React.ReactNode {
  const { sources, focused } = props;

  if (sources.length === 0) {
    return null;
  }

  return (
    <PanelChrome title="New Data Source Detected" focused={focused}>
      <box flexDirection="column" paddingLeft={1}>
        <text fg={COLORS.dim}>
          {"The following data source(s) were discovered during this session:"}
        </text>

        {sources.map((s) => (
          <box key={s.name} flexDirection="column" marginTop={1}>
            <text fg={COLORS.white}>
              <b>{`  ${s.name}`}</b>
            </text>
            <text fg={COLORS.dim}>{`  Protocol: ${s.protocol}  |  Origin: ${s.source}`}</text>
          </box>
        ))}
      </box>

      <box height={1} marginTop={2} flexDirection="row" paddingLeft={1}>
        {focused ? (
          <>
            <text fg={COLORS.green}>{"[y] Approve  "}</text>
            <text fg={COLORS.red}>{"[n] Deny  "}</text>
            <text fg={COLORS.cyan}>{"[d] Details  "}</text>
            <text fg={COLORS.dim}>{"[Esc] Dismiss"}</text>
          </>
        ) : null}
      </box>
    </PanelChrome>
  );
}
