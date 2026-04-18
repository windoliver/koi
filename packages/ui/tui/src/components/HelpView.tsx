/**
 * HelpView — "help" screen (activeView === "help").
 *
 * Static keybinding reference and command palette command list.
 * No store reads required — all content is compile-time constant.
 */

import type { JSX } from "solid-js";
import { COMMAND_DEFINITIONS } from "../commands/command-definitions.js";
import { COLORS } from "../theme.js";

const KEYBINDINGS = [
  { key: "Ctrl+P", action: "Open command palette" },
  { key: "Ctrl+N", action: "Start a new session" },
  { key: "Ctrl+S", action: "Open sessions picker" },
  { key: "Ctrl+C", action: "Interrupt agent" },
  { key: "Esc", action: "Dismiss modal · back to conversation" },
  { key: "Enter", action: "Submit message" },
  { key: "Ctrl+J", action: "Insert newline in message" },
] as const;

export function HelpView(): JSX.Element {
  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={2} paddingRight={2} paddingTop={1}>
      <text fg={COLORS.cyan}>{"Keyboard Shortcuts"}</text>
      <text>{" "}</text>
      {KEYBINDINGS.map(({ key, action }) => (
        <box flexDirection="row" gap={2}>
          <text fg={COLORS.accent}>{key.padEnd(10)}</text>
          <text fg={COLORS.dim}>{action}</text>
        </box>
      ))}
      <text>{" "}</text>
      <text fg={COLORS.cyan}>{"Command Palette  (Ctrl+P)"}</text>
      <text>{" "}</text>
      {COMMAND_DEFINITIONS.map((cmd) => (
        <box flexDirection="row" gap={2}>
          <text fg={COLORS.white}>{cmd.label.padEnd(20)}</text>
          <text fg={COLORS.dim}>{cmd.description}</text>
        </box>
      ))}
    </box>
  );
}
