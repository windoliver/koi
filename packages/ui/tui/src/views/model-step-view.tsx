/**
 * Model selection step — shows known models as a selectable list.
 *
 * j/k navigation, Enter to select.
 */

import { useState } from "react";
import { COLORS } from "../theme.js";

export interface ModelStepViewProps {
  readonly models: readonly string[];
  readonly selectedModel: string;
  readonly onSelect: (model: string) => void;
  readonly focused?: boolean | undefined;
}

/** Model selection step view. */
export function ModelStepView(props: ModelStepViewProps): React.ReactNode {
  const { models, selectedModel, focused } = props;
  const initialIndex = Math.max(0, models.indexOf(selectedModel));
  const [focusedIndex, setFocusedIndex] = useState(initialIndex);

  // The parent keyboard handler will call onSelect — this is just display
  const _ = { setFocusedIndex }; // suppress unused warning for local state

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
