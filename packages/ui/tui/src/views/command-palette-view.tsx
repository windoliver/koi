/**
 * Command palette view — overlay select for slash commands with filtering.
 *
 * Renders as an absolutely positioned box with a search input and a filtered
 * Select list of available commands. Shown when view === "palette".
 */

import type { SelectOption } from "@opentui/core";
import { useCallback, useMemo, useState } from "react";
import type { TuiCapabilities } from "../state/domain-types.js";
import { COLORS } from "../theme.js";
import { DEFAULT_COMMANDS, filterCommandsByCapabilities } from "./command-palette.js";

/** Case-insensitive substring match against name and description. */
function matchesFilter(option: SelectOption, query: string): boolean {
  const lower = query.toLowerCase();
  const nameMatch = (option.name ?? "").toLowerCase().includes(lower);
  const descMatch = (option.description ?? "").toLowerCase().includes(lower);
  return nameMatch || descMatch;
}

/** Props for the command palette overlay. */
export interface CommandPaletteViewProps {
  readonly visible: boolean;
  readonly onSelect: (commandId: string) => void;
  readonly onCancel: () => void;
  readonly focused: boolean;
  readonly capabilities?: TuiCapabilities | null | undefined;
}

/** Command palette — overlay select with filtering. */
export function CommandPaletteView(props: CommandPaletteViewProps): React.ReactNode {
  const [filter, setFilter] = useState("");

  const commandOptions = useMemo((): readonly SelectOption[] => {
    const caps = props.capabilities ?? null;
    const filtered = filterCommandsByCapabilities(DEFAULT_COMMANDS, caps);
    return filtered.map((cmd) => ({
      name: cmd.label,
      description: cmd.shortcut !== undefined ? `${cmd.description}  (${cmd.shortcut})` : cmd.description,
      value: cmd.id,
    }));
  }, [props.capabilities]);

  const filteredOptions = useMemo((): readonly SelectOption[] => {
    if (filter === "") return commandOptions;
    return commandOptions.filter((opt) => matchesFilter(opt, filter));
  }, [filter, commandOptions]);

  const handleInput = useCallback((value: string) => { setFilter(value); }, []);

  if (!props.visible) return null;

  return (
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
          onInput={handleInput}
        />
      </box>

      {filteredOptions.length > 0 ? (
        <select
          options={filteredOptions as SelectOption[]}
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
      ) : (
        <box height={1} paddingLeft={1}>
          <text fg={COLORS.dim}>No matching commands</text>
        </box>
      )}
    </box>
  );
}
