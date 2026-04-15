/**
 * McpView — full-screen interactive MCP server status view.
 *
 * Accessible via /mcp. Arrow keys to navigate, Enter to authenticate
 * a needs-auth server, Esc to go back. Follows the CC MCPListPanel pattern.
 */

import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import type { JSX } from "solid-js";
import { createMemo, For, Show } from "solid-js";
import type { McpServerInfo } from "../state/types.js";
import { useTuiStore } from "../store-context.js";
import { COLORS } from "../theme.js";
import { createScrollableList } from "./select-overlay-helpers.js";

// ---------------------------------------------------------------------------
// Status display config
// ---------------------------------------------------------------------------

const STATUS_CONFIG: Record<
  McpServerInfo["status"],
  { readonly icon: string; readonly color: string; readonly label: string }
> = {
  connected: { icon: "✓", color: COLORS.success, label: "connected" },
  "needs-auth": { icon: "△", color: COLORS.amber, label: "needs authentication" },
  error: { icon: "✗", color: COLORS.danger, label: "error" },
  pending: { icon: "○", color: COLORS.textMuted, label: "connecting" },
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface McpViewProps {
  /** Route an action to the CLI host (triggers koi mcp auth <name>). */
  readonly onCommand: (commandId: string, args: string) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function McpView(props: McpViewProps): JSX.Element {
  const mcpServers = useTuiStore((s) => s.mcpServers);
  const list = createScrollableList(() => [...mcpServers()], 12);

  const selectedServer = createMemo((): McpServerInfo | undefined => mcpServers()[list.selectedIdx()]);

  useKeyboard((key: KeyEvent) => {
    if (key.name === "up" || (key.ctrl && key.name === "p")) {
      key.preventDefault();
      list.moveUp();
    } else if (key.name === "down" || (key.ctrl && key.name === "n")) {
      key.preventDefault();
      list.moveDown();
    } else if (key.name === "return") {
      key.preventDefault();
      const server = selectedServer();
      if (server !== undefined && server.status === "needs-auth") {
        props.onCommand("nav:mcp-auth", server.name);
      }
    }
  });

  return (
    <box flexDirection="column" flexGrow={1} height="100%" paddingLeft={2} paddingTop={1}>
      <text fg={COLORS.cyan}>
        <b>{"MCP Servers"}</b>
      </text>
      <text fg={COLORS.textMuted}>{"↑↓ navigate · Enter authenticate · Esc back"}</text>

      <Show
        when={mcpServers().length > 0}
        fallback={
          <box paddingTop={1} flexGrow={1}>
            <text fg={COLORS.textMuted}>
              {"No MCP servers configured. Add .mcp.json to project root or ~/.koi/.mcp.json"}
            </text>
          </box>
        }
      >
        <box flexDirection="row" flexGrow={1} gap={2} paddingTop={1}>
          {/* Left: Server list */}
          <box flexDirection="column" width="40%">
            <For each={list.visibleItems()}>
              {(server, localIdx) => {
                const isSelected = (): boolean =>
                  list.visibleStart() + localIdx() === list.selectedIdx();
                const cfg = STATUS_CONFIG[server.status];
                return (
                  <box flexDirection="row" gap={1} paddingLeft={1}>
                    <text fg={isSelected() ? COLORS.yellow : COLORS.dim}>
                      {isSelected() ? "❯" : " "}
                    </text>
                    <text fg={isSelected() ? COLORS.white : COLORS.textSecondary}>
                      {server.name}
                    </text>
                    <text fg={COLORS.dim}>{"·"}</text>
                    <text fg={cfg.color}>
                      {`${cfg.icon} ${cfg.label}`}
                    </text>
                  </box>
                );
              }}
            </For>
          </box>

          {/* Right: Detail panel */}
          <box flexDirection="column" flexGrow={1} borderStyle="rounded" borderColor={COLORS.border} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
            <Show
              when={selectedServer()}
              fallback={<text fg={COLORS.textMuted}>{"Select a server"}</text>}
            >
              {(server: () => McpServerInfo) => {
                const cfg = STATUS_CONFIG[server().status];
                return (
                  <box flexDirection="column">
                    <box flexDirection="row" gap={1}>
                      <text fg={cfg.color}>{cfg.icon}</text>
                      <text fg={COLORS.white}>
                        <b>{server().name}</b>
                      </text>
                    </box>

                    <box paddingTop={1}>
                      <text fg={COLORS.dim}>{"Status: "}</text>
                      <text fg={cfg.color}>{cfg.label}</text>
                    </box>

                    <Show when={server().toolCount > 0}>
                      <box>
                        <text fg={COLORS.dim}>{"Tools:  "}</text>
                        <text fg={COLORS.success}>{`${server().toolCount}`}</text>
                      </box>
                    </Show>

                    <Show when={server().detail !== undefined}>
                      <box paddingTop={1}>
                        <text fg={COLORS.textSecondary}>{server().detail ?? ""}</text>
                      </box>
                    </Show>

                    <Show when={server().status === "needs-auth"}>
                      <box paddingTop={1} flexDirection="column">
                        <text fg={COLORS.amber}>
                          {"Press Enter to authenticate"}
                        </text>
                        <text fg={COLORS.textMuted}>
                          {"or: koi mcp auth " + server().name}
                        </text>
                      </box>
                    </Show>

                    <Show when={server().status === "error"}>
                      <box paddingTop={1}>
                        <text fg={COLORS.danger}>{"Check network or server URL."}</text>
                      </box>
                    </Show>

                    <Show when={server().status === "connected" && server().toolCount === 0}>
                      <box paddingTop={1}>
                        <text fg={COLORS.textMuted}>{"Authenticated — tools load on first use"}</text>
                      </box>
                    </Show>
                  </box>
                );
              }}
            </Show>
          </box>
        </box>
      </Show>
    </box>
  );
}
