/**
 * PluginsView — "plugins" screen (activeView === "plugins").
 *
 * Shows discovered plugins: name, version, source, description.
 * Shows plugin load errors inline.
 * Read-only display — no interactive elements.
 */

import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import type { PluginSummary } from "../state/types.js";
import { useTuiStore } from "../store-context.js";
import { COLORS } from "../theme.js";

// ---------------------------------------------------------------------------
// Pure display logic (exported for testing)
// ---------------------------------------------------------------------------

export interface DisplayLine {
  readonly kind: "header" | "plugin" | "error" | "info";
  readonly text: string;
  readonly detail?: string | undefined;
}

/**
 * Strip ANSI escape sequences and control characters from untrusted plugin text.
 * Plugin names, versions, descriptions, and error messages originate from
 * plugin.json manifests which are untrusted user-installed content.
 */
const ANSI_RE = new RegExp("\\x1b\\[[0-9;]*[a-zA-Z]", "g");
const CTRL_RE = new RegExp("[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]", "g");
function sanitize(s: string): string {
  return s.replace(ANSI_RE, "").replace(CTRL_RE, "");
}

export function buildPluginDisplayLines(summary: PluginSummary | null): readonly DisplayLine[] {
  if (summary === null || (summary.loaded.length === 0 && summary.errors.length === 0)) {
    return [{ kind: "info", text: "No plugins loaded." }];
  }

  const lines: DisplayLine[] = [];

  if (summary.loaded.length > 0) {
    lines.push({ kind: "header", text: `Loaded Plugins (${String(summary.loaded.length)})` });
    for (const p of summary.loaded) {
      lines.push({
        kind: "plugin",
        text: sanitize(p.name),
        detail: `v${sanitize(p.version)} (${p.source}) \u2014 ${sanitize(p.description)}`,
      });
    }
  }

  if (summary.errors.length > 0) {
    lines.push({ kind: "header", text: `Errors (${String(summary.errors.length)})` });
    for (const e of summary.errors) {
      lines.push({ kind: "error", text: sanitize(e.plugin), detail: sanitize(e.error) });
    }
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PluginsView(): JSX.Element {
  const pluginSummary = useTuiStore((s) => s.pluginSummary);
  const lines = (): readonly DisplayLine[] => buildPluginDisplayLines(pluginSummary());

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={2} paddingRight={2} paddingTop={1}>
      <text fg={COLORS.cyan}>{"Plugins"}</text>
      <text>{" "}</text>
      <For each={lines()}>
        {(line) => (
          <Show
            when={line.kind !== "info"}
            fallback={<text fg={COLORS.dim}>{line.text}</text>}
          >
            <Show when={line.kind === "header"}>
              <text fg={COLORS.white}>{line.text}</text>
            </Show>
            <Show when={line.kind === "plugin"}>
              <box flexDirection="row" gap={1}>
                <text fg={COLORS.green}>{`  ${line.text}`}</text>
                <text fg={COLORS.dim}>{line.detail ?? ""}</text>
              </box>
            </Show>
            <Show when={line.kind === "error"}>
              <box flexDirection="row" gap={1}>
                <text fg={COLORS.yellow}>{`  \u26A0 ${line.text}`}</text>
                <text fg={COLORS.dim}>{line.detail ?? ""}</text>
              </box>
            </Show>
          </Show>
        )}
      </For>
    </box>
  );
}
