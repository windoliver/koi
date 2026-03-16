/**
 * Model selection step — shows known models as a selectable list.
 *
 * j/k navigation, Enter to select. Focus index managed by parent store.
 */

import { COLORS } from "../theme.js";

export interface ModelStepViewProps {
  readonly models: readonly string[];
  readonly selectedModel: string;
  readonly focusedIndex: number;
  readonly onSelect: (model: string) => void;
  readonly focused?: boolean | undefined;
}

/** Model selection step view. */
export function ModelStepView(props: ModelStepViewProps): React.ReactNode {
  const { models, selectedModel, focusedIndex } = props;

  return (
    <box flexGrow={1} flexDirection="column" paddingLeft={2} paddingTop={1}>
      <text fg={COLORS.cyan}><b>{"  Select Model"}</b></text>
      <box marginTop={1} paddingLeft={2} flexDirection="column">
        {models.map((model, i) => (
          <box key={model} height={1} flexDirection="row">
            <text fg={i === focusedIndex ? COLORS.cyan : COLORS.dim}>
              {i === focusedIndex ? " > " : "   "}
            </text>
            <text fg={i === focusedIndex ? COLORS.white : COLORS.dim}>
              {model}
            </text>
            {model === selectedModel && (
              <text fg={COLORS.green}>{" (current)"}</text>
            )}
          </box>
        ))}
      </box>
      <box marginTop={1} paddingLeft={2}>
        <text fg={COLORS.dim}>{"  j/k:navigate  Enter:select  Esc:back"}</text>
      </box>
    </box>
  );
}
