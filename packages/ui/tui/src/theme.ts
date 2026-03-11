/**
 * Koi TUI theme — consistent styling for all pi-tui components.
 *
 * Uses chalk for ANSI styling. All theme functions are pure
 * string transformers with zero side effects.
 */

import type { MarkdownTheme, SelectListTheme } from "@mariozechner/pi-tui";
import chalk from "chalk";

/** Koi-branded select list theme for agent lists and command palette. */
export const KOI_SELECT_THEME: SelectListTheme = {
  selectedPrefix: (t: string) => chalk.cyan(t),
  selectedText: (t: string) => chalk.bold.white(t),
  description: (t: string) => chalk.dim(t),
  scrollInfo: (t: string) => chalk.dim(t),
  noMatch: (t: string) => chalk.yellow(t),
};

/** Koi-branded markdown theme for agent console output. */
export const KOI_MARKDOWN_THEME: MarkdownTheme = {
  heading: (t: string) => chalk.bold.cyan(t),
  link: (t: string) => chalk.underline.blue(t),
  linkUrl: (t: string) => chalk.dim(t),
  code: (t: string) => chalk.yellow(t),
  codeBlock: (t: string) => chalk.gray(t),
  codeBlockBorder: (t: string) => chalk.dim(t),
  quote: (t: string) => chalk.italic(t),
  quoteBorder: (t: string) => chalk.dim(t),
  hr: (t: string) => chalk.dim(t),
  listBullet: (t: string) => chalk.cyan(t),
  bold: (t: string) => chalk.bold(t),
  italic: (t: string) => chalk.italic(t),
  strikethrough: (t: string) => chalk.strikethrough(t),
  underline: (t: string) => chalk.underline(t),
};

// ─── Style helpers for custom components ─────────────────────────────

/** Style a status bar label. */
export function styleStatusLabel(text: string): string {
  return chalk.bgCyan.black(` ${text} `);
}

/** Style a status bar value. */
export function styleStatusValue(text: string): string {
  return chalk.dim(text);
}

/** Style a horizontal rule. */
export function styleHr(width: number): string {
  return chalk.dim("─".repeat(width));
}

/** Style a section header. */
export function styleHeader(text: string): string {
  return chalk.bold(text);
}

/** Style an error message. */
export function styleError(text: string): string {
  return chalk.red(text);
}

/** Style a warning message. */
export function styleWarning(text: string): string {
  return chalk.yellow(text);
}

/** Style a success message. */
export function styleSuccess(text: string): string {
  return chalk.green(text);
}

/** Style dim/secondary text. */
export function styleDim(text: string): string {
  return chalk.dim(text);
}

/** Style for connection status indicators. */
export function styleConnectionStatus(
  status: "connected" | "reconnecting" | "disconnected",
): string {
  switch (status) {
    case "connected":
      return `${chalk.green("●")} connected`;
    case "reconnecting":
      return `${chalk.yellow("◌")} reconnecting…`;
    case "disconnected":
      return `${chalk.red("○")} disconnected`;
  }
}

/** Style for agent process state. */
export function styleAgentState(
  state: "created" | "running" | "waiting" | "suspended" | "idle" | "terminated",
): string {
  switch (state) {
    case "created":
      return chalk.blue(state);
    case "running":
      return chalk.green(state);
    case "waiting":
      return chalk.yellow(state);
    case "idle":
      return chalk.cyan(state);
    case "suspended":
      return chalk.magenta(state);
    case "terminated":
      return chalk.dim(state);
  }
}
