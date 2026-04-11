/**
 * AtOverlay — file path completion overlay for @-mention input (#10).
 *
 * Shown when the user types "@" in InputArea. Reads atResults from the store.
 * Keyboard navigation (Up/Down, Tab, Enter to select, Esc to dismiss).
 * On select: calls onSelect with the file path.
 */

import type { JSX } from "solid-js";
import { useTuiStore } from "../store-context.js";
import { COLORS } from "../theme.js";
import { SelectOverlay } from "./SelectOverlay.js";

export interface AtOverlayProps {
  readonly query: string;
  readonly onSelect: (path: string) => void;
  readonly onDismiss: () => void;
  readonly focused: boolean;
}

const getLabel = (path: string): string => path;
const getDescription = (path: string): string => path;

export function AtOverlay(props: AtOverlayProps): JSX.Element {
  const atResults = useTuiStore((s) => s.atResults);

  return (
    <box
      flexDirection="column"
      border={true}
      borderColor={COLORS.blueAccent}
      width={60}
      maxHeight={12}
    >
      {/* Header */}
      <box paddingLeft={1}>
        <text fg={COLORS.blueAccent}>
          <b>{"Files"}</b>
        </text>
        <text fg={COLORS.textMuted}>{` — ${props.query}`}</text>
      </box>

      <SelectOverlay
        items={atResults()}
        getLabel={getLabel}
        getDescription={getDescription}
        onSelect={props.onSelect}
        onClose={props.onDismiss}
        focused={props.focused}
        emptyText="No matching files"
      />
    </box>
  );
}
