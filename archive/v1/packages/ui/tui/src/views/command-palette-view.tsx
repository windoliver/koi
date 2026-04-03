/**
 * Command palette view — overlay select for slash commands with filtering.
 *
 * Renders as an absolutely positioned box with a search input and a filtered
 * Select list of available commands. Shown when view === "palette".
 *
 * Focus goes to the <input> so printable keys filter the list. Arrow keys
 * and Enter are routed from the TuiRoot keyboard handler via signal props.
 */

import type { SelectOption } from "@opentui/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  /** Incremented by the keyboard handler when down arrow is pressed. */
  readonly navigateDown?: number | undefined;
  /** Incremented by the keyboard handler when up arrow is pressed. */
  readonly navigateUp?: number | undefined;
  /** Incremented by the keyboard handler when Enter is pressed. */
  readonly confirmSignal?: number | undefined;
}

/** Command palette — overlay select with filtering. */
export function CommandPaletteView(props: CommandPaletteViewProps): React.ReactNode {
  const [filter, setFilter] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  // Incremented on each open to force <input> remount (clears internal buffer)
  const [inputKey, setInputKey] = useState(0);

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

  // Reset selection when filter changes
  const prevFilterRef = useRef(filter);
  useEffect(() => {
    if (prevFilterRef.current !== filter) {
      prevFilterRef.current = filter;
      setSelectedIndex(0);
    }
  }, [filter]);

  // Reset filter and index when palette opens — remount input to clear buffer
  useEffect(() => {
    if (props.visible) {
      setFilter("");
      setSelectedIndex(0);
      setInputKey((k) => k + 1);
    }
  }, [props.visible]);

  // Navigate down signal
  const prevDownRef = useRef(props.navigateDown ?? 0);
  useEffect(() => {
    const current = props.navigateDown ?? 0;
    if (current !== prevDownRef.current) {
      prevDownRef.current = current;
      setSelectedIndex((prev) => (prev + 1) % Math.max(filteredOptions.length, 1));
    }
  }, [props.navigateDown, filteredOptions.length]);

  // Navigate up signal
  const prevUpRef = useRef(props.navigateUp ?? 0);
  useEffect(() => {
    const current = props.navigateUp ?? 0;
    if (current !== prevUpRef.current) {
      prevUpRef.current = current;
      setSelectedIndex((prev) =>
        (prev - 1 + Math.max(filteredOptions.length, 1)) % Math.max(filteredOptions.length, 1),
      );
    }
  }, [props.navigateUp, filteredOptions.length]);

  // Confirm selection signal
  const prevConfirmRef = useRef(props.confirmSignal ?? 0);
  useEffect(() => {
    const current = props.confirmSignal ?? 0;
    if (current !== prevConfirmRef.current) {
      prevConfirmRef.current = current;
      const option = filteredOptions[selectedIndex];
      if (option?.value !== undefined) {
        props.onSelect(option.value as string);
      }
    }
  }, [props.confirmSignal, filteredOptions, selectedIndex, props.onSelect]);

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
          key={`palette-input-${String(inputKey)}`}
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
          focused={false}
          selectedIndex={selectedIndex}
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
