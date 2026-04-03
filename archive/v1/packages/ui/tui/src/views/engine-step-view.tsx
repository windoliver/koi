/**
 * Engine selection step — optional engine override or auto-detect.
 *
 * Enter to confirm, s to skip.
 */

import { COLORS } from "../theme.js";

export interface EngineStepViewProps {
  readonly selectedEngine: string | undefined;
  readonly focused?: boolean | undefined;
}

/** Engine selection step view. */
export function EngineStepView(props: EngineStepViewProps): React.ReactNode {
  const { selectedEngine } = props;

  return (
    <box flexGrow={1} flexDirection="column" paddingLeft={2} paddingTop={1}>
      <text fg={COLORS.cyan}><b>{"  Engine Selection"}</b></text>
      <box marginTop={1} paddingLeft={2} flexDirection="column">
        <text fg={COLORS.dim}>{"  Engine determines the agent loop strategy."}</text>
        <box marginTop={1} paddingLeft={2}>
          <text fg={COLORS.white}>
            {selectedEngine !== undefined
              ? `Current: ${selectedEngine}`
              : "Auto-detect (recommended)"}
          </text>
        </box>
        <box marginTop={1} paddingLeft={2} flexDirection="column">
          <text fg={COLORS.dim}>{"  Available engines are resolved from your manifest."}</text>
          <text fg={COLORS.dim}>{"  Press 's' to skip and use auto-detection."}</text>
        </box>
      </box>
      <box marginTop={1} paddingLeft={2}>
        <text fg={COLORS.dim}>{"  Enter:confirm  s:skip  Esc:back"}</text>
      </box>
    </box>
  );
}
