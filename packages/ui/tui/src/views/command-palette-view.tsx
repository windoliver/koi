/**
 * Command palette view — overlay select for slash commands.
 *
 * Renders as an absolutely positioned box with a Select list
 * of available commands. Shown when view === "palette".
 */

import type { SelectOption } from "@opentui/core";
import type { JSX } from "@opentui/solid";
import type { Accessor } from "solid-js";
import { Show } from "solid-js";
import { COLORS } from "../theme.js";
import { DEFAULT_COMMANDS } from "./command-palette.js";

/** Precomputed select options from default commands. */
const COMMAND_OPTIONS: readonly SelectOption[] = DEFAULT_COMMANDS.map((cmd) => ({
  name: cmd.label,
  description: cmd.shortcut !== undefined ? `${cmd.description}  (${cmd.shortcut})` : cmd.description,
  value: cmd.id,
}));

/** Props for the command palette overlay. */
export interface CommandPaletteViewProps {
  readonly visible: Accessor<boolean>;
  readonly onSelect: (commandId: string) => void;
  readonly onCancel: () => void;
  readonly focused: boolean;
}

/** Command palette — overlay select with available slash commands. */
export function CommandPaletteView(props: CommandPaletteViewProps): JSX.Element {
  return (
    <Show when={props.visible()}>
      <box
        position="absolute"
        top={2}
        left={10}
        width={60}
        height={18}
        border={true}
        borderColor={COLORS.cyan}
        backgroundColor={COLORS.bg}
        flexDirection="column"
        zIndex={10}
      >
        <box height={1}>
          <text fg={COLORS.cyan}><b>{" Commands"}</b></text>
        </box>

        <select
          options={COMMAND_OPTIONS as SelectOption[]}
          focused={props.focused}
          showDescription={true}
          wrapSelection={true}
          selectedBackgroundColor={COLORS.blue}
          selectedTextColor={COLORS.white}
          descriptionColor={COLORS.dim}
          onSelect={(index: number, option: SelectOption | null) => {
            if (option?.value !== undefined) {
              props.onSelect(option.value as string);
            }
          }}
        />
      </box>
    </Show>
  );
}
