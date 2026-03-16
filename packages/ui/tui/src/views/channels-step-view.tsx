/**
 * Channel selection step — multiselect checkboxes for known channels.
 *
 * Same UX pattern as addon-picker-view: j/k, Space toggle, Enter confirm.
 */

import { COLORS } from "../theme.js";

export interface ChannelsStepViewProps {
  readonly channels: readonly string[];
  readonly selected: readonly string[];
  readonly focusedIndex: number;
  readonly focused?: boolean | undefined;
}

/** Channel selection step view. */
export function ChannelsStepView(props: ChannelsStepViewProps): React.ReactNode {
  const { channels, selected, focusedIndex } = props;
  const selectedSet = new Set(selected);

  return (
    <box flexGrow={1} flexDirection="column" paddingLeft={2} paddingTop={1}>
      <text fg={COLORS.cyan}><b>{"  Select Channels"}</b></text>
      <text fg={COLORS.dim}>{"  Choose I/O interfaces for your agent."}</text>
      <box marginTop={1} paddingLeft={2} flexDirection="column">
        {channels.map((ch, i) => {
          const isFocused = i === focusedIndex;
          const isSelected = selectedSet.has(ch);
          return (
            <box key={ch} height={1} flexDirection="row">
              <text fg={isFocused ? COLORS.cyan : COLORS.dim}>
                {isFocused ? " > " : "   "}
              </text>
              <text fg={isSelected ? COLORS.green : COLORS.dim}>
                {isSelected ? "[x] " : "[ ] "}
              </text>
              <text fg={isFocused ? COLORS.white : COLORS.dim}>
                {ch}
              </text>
            </box>
          );
        })}
      </box>
      <box marginTop={1} paddingLeft={2}>
        <text fg={COLORS.dim}>{"  j/k:navigate  Space:toggle  Enter:confirm  Esc:back"}</text>
      </box>
    </box>
  );
}
