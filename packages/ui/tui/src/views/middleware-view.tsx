import { PanelChrome } from "../components/panel-chrome.js";
import type { MiddlewareViewState } from "../state/domain-types.js";
import { COLORS } from "../theme.js";

export interface MiddlewareViewProps {
  readonly middlewareView: MiddlewareViewState;
  readonly focused: boolean;
  readonly zoomLevel?: "normal" | "half" | "full" | undefined;
}

export function MiddlewareView(props: MiddlewareViewProps): React.ReactNode {
  const { chain, loading } = props.middlewareView;
  const entries = chain?.entries ?? [];

  return (
    <PanelChrome
      title="Middleware"
      count={entries.length}
      focused={props.focused}
      zoomLevel={props.zoomLevel}
      loading={loading}
      isEmpty={chain === null && !loading}
      emptyMessage="No middleware chain loaded."
      emptyHint="Select an agent to view its middleware chain."
    >
      {chain !== null && (
        <box flexDirection="column">
          <box height={1}>
            <text fg={COLORS.dim}>{` Agent: ${String(chain.agentId)}`}</text>
          </box>
          <box height={1}>
            <text fg={COLORS.dim}>{" #  Name                 Phase        Enabled"}</text>
          </box>
          {entries.map((entry, i) => (
            <box key={entry.name} height={1}>
              <text>
                {` ${String(i + 1).padStart(2)} ${entry.name.padEnd(20).slice(0, 20)} ${entry.phase.padEnd(12)} ${entry.enabled ? "●" : "○"}`}
              </text>
            </box>
          ))}
        </box>
      )}
    </PanelChrome>
  );
}
