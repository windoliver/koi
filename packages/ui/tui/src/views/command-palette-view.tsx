/**
 * Command palette view — overlay select for slash commands with fuzzy-search filtering.
 *
 * Renders as an absolutely positioned box with a search input and a filtered
 * Select list of available commands. Shown when view === "palette".
 */

import type { SelectOption } from "@opentui/core";
import type { JSX } from "@opentui/solid";
import type { Accessor } from "solid-js";
import { Show, createMemo, createSignal } from "solid-js";
import { COLORS } from "../theme.js";
import { DEFAULT_COMMANDS } from "./command-palette.js";

/** Precomputed select options from default commands. */
const COMMAND_OPTIONS: readonly SelectOption[] = DEFAULT_COMMANDS.map((cmd) => ({
  name: cmd.label,
  description: cmd.shortcut !== undefined ? `${cmd.description}  (${cmd.shortcut})` : cmd.description,
  value: cmd.id,
}));

/** Case-insensitive substring match against name and description. */
function matchesFilter(option: SelectOption, query: string): boolean {
  const lower = query.toLowerCase();
  const nameMatch = (option.name ?? "").toLowerCase().includes(lower);
  const descMatch = (option.description ?? "").toLowerCase().includes(lower);
  return nameMatch || descMatch;
}

/** Props for the command palette overlay. */
export interface CommandPaletteViewProps {
  readonly visible: Accessor<boolean>;
  readonly onSelect: (commandId: string) => void;
  readonly onCancel: () => void;
  readonly focused: boolean;
}

/** Command palette — overlay select with fuzzy-search filtering. */
export function CommandPaletteView(props: CommandPaletteViewProps): JSX.Element {
  const [filter, setFilter] = createSignal("");

  const filteredOptions = createMemo((): readonly SelectOption[] => {
    const query = filter();
    if (query === "") {
      return COMMAND_OPTIONS;
    }
    return COMMAND_OPTIONS.filter((opt) => matchesFilter(opt, query));
  });

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

        <box height={1}>
          <input
            focused={props.focused}
            placeholder="Type to filter…"
            placeholderColor={COLORS.dim}
            backgroundColor={COLORS.bg}
            textColor={COLORS.white}
            onInput={(value: string) => { setFilter(value); }}
          />
        </box>

        <Show
          when={filteredOptions().length > 0}
          fallback={
            <box height={1} paddingLeft={1}>
              <text fg={COLORS.dim}>No matching commands</text>
            </box>
          }
        >
          <select
            options={filteredOptions() as SelectOption[]}
            focused={props.focused}
            showDescription={true}
            wrapSelection={true}
            flexGrow={1}
            selectedBackgroundColor={COLORS.blue}
            selectedTextColor={COLORS.white}
            descriptionColor={COLORS.dim}
            onSelect={(index: number, option: SelectOption | null) => {
              if (option?.value !== undefined) {
                props.onSelect(option.value as string);
              }
            }}
          />
        </Show>
      </box>
    </Show>
  );
}
