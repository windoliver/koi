/**
 * AgentSplitPane — renders 2-4 agent panes side-by-side, each with
 * its own terminal emulator instance for PTY output.
 */

import type { ReactNode } from "react";
import { useEffect, useMemo, useRef } from "react";
import type { TerminalConfig, TerminalInstance } from "../lib/ghostty-wasm.js";
import { createTerminal } from "../lib/ghostty-wasm.js";
import { agentStateColor, COLORS } from "../theme.js";

// ─── Types ──────────────────────────────────────────────────────────

type AgentState = "created" | "running" | "waiting" | "suspended" | "idle" | "terminated";

export interface AgentPaneData {
  readonly agentId: string;
  readonly agentName: string;
  readonly state: AgentState;
  readonly ptyData?: Uint8Array | undefined;
}

export interface AgentSplitPaneProps {
  readonly panes: readonly AgentPaneData[];
  readonly focusedIndex: number;
  readonly onFocusChange: (index: number) => void;
  readonly onZoomToggle: (agentId: string) => void;
  readonly maxScrollback?: number | undefined;
}

const STATE_SYMBOL: Record<AgentState, string> = {
  created: "\u25C9",   // ◉
  running: "\u25CF",   // ●
  waiting: "\u25D0",   // ◐
  idle: "\u25CB",      // ○
  suspended: "\u2298", // ⊘
  terminated: "\u2715", // ✕
} as const;

interface SinglePaneProps {
  readonly pane: AgentPaneData;
  readonly terminal: TerminalInstance;
  readonly focused: boolean;
}

function SinglePane(props: SinglePaneProps): ReactNode {
  const { pane, terminal, focused } = props;
  const symbol = STATE_SYMBOL[pane.state];
  const stateColor = agentStateColor(pane.state);
  const borderColor = focused ? COLORS.cyan : COLORS.dim;
  const lines = terminal.render();

  return (
    <box flexGrow={1} flexDirection="column" border borderStyle="rounded" borderColor={borderColor}>
      <box height={1} flexDirection="row">
        <text fg={stateColor}>{`${symbol} `}</text>
        <text fg={borderColor}><b>{pane.agentName}</b></text>
      </box>
      <box flexGrow={1} flexDirection="column">
        {lines.map((line, i) => (
          <text key={i} fg={COLORS.white}>{line}</text>
        ))}
      </box>
    </box>
  );
}

export function AgentSplitPane(props: AgentSplitPaneProps): ReactNode {
  const terminalsRef = useRef<Map<string, TerminalInstance>>(new Map());

  const terminalConfig = useMemo(
    (): TerminalConfig => ({ maxScrollback: props.maxScrollback }),
    [props.maxScrollback],
  );

  // Ensure a terminal exists for each pane and clean up stale ones.
  const activeIds = useMemo(() => new Set(props.panes.map((p) => p.agentId)), [props.panes]);

  useEffect(() => {
    const terminals = terminalsRef.current;
    // Create terminals for new panes.
    for (const pane of props.panes) {
      if (!terminals.has(pane.agentId)) {
        terminals.set(pane.agentId, createTerminal(terminalConfig));
      }
    }
    // Destroy terminals for removed panes.
    for (const [id, terminal] of terminals) {
      if (!activeIds.has(id)) {
        terminal.destroy();
        terminals.delete(id);
      }
    }
  }, [activeIds, props.panes, terminalConfig]);

  // Write ptyData into each terminal when it arrives.
  useEffect(() => {
    const terminals = terminalsRef.current;
    for (const pane of props.panes) {
      if (pane.ptyData !== undefined && pane.ptyData.length > 0) {
        terminals.get(pane.agentId)?.write(pane.ptyData);
      }
    }
  }, [props.panes]);

  // Cleanup all terminals on unmount.
  useEffect(() => {
    const terminals = terminalsRef.current;
    return () => {
      for (const terminal of terminals.values()) {
        terminal.destroy();
      }
      terminals.clear();
    };
  }, []);

  return (
    <box flexGrow={1} flexDirection="row">
      {props.panes.map((pane, index) => {
        const terminal = terminalsRef.current.get(pane.agentId);
        if (terminal === undefined) return null;
        return (
          <SinglePane
            key={pane.agentId}
            pane={pane}
            terminal={terminal}
            focused={index === props.focusedIndex}
          />
        );
      })}
    </box>
  );
}
