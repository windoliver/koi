/**
 * Zustand store for per-agent terminal state — PTY data buffers and mode toggle.
 *
 * SSE pty_output events append base64-encoded chunks here. The AgentTerminal
 * component reads from the buffer and writes decoded bytes to the ghostty-web
 * Terminal instance.
 */

import { create } from "zustand";

interface TerminalState {
  /** Per-agent PTY data buffers (base64-encoded chunks). */
  readonly ptyBuffers: Readonly<Record<string, readonly string[]>>;
  /** Whether terminal mode is active for an agent. */
  readonly terminalActive: Readonly<Record<string, boolean>>;

  readonly appendPtyData: (agentId: string, data: string) => void;
  readonly clearPtyBuffer: (agentId: string) => void;
  readonly setTerminalActive: (agentId: string, active: boolean) => void;
}

export const useTerminalStore = create<TerminalState>((set) => ({
  ptyBuffers: {},
  terminalActive: {},

  appendPtyData: (agentId, data) =>
    set((state) => {
      const existing = state.ptyBuffers[agentId] ?? [];
      return {
        ptyBuffers: {
          ...state.ptyBuffers,
          [agentId]: [...existing, data],
        },
      };
    }),

  clearPtyBuffer: (agentId) =>
    set((state) => {
      const { [agentId]: _, ...rest } = state.ptyBuffers;
      return { ptyBuffers: rest };
    }),

  setTerminalActive: (agentId, active) =>
    set((state) => ({
      terminalActive: {
        ...state.terminalActive,
        [agentId]: active,
      },
    })),
}));

/** Select PTY data buffer for a specific agent. */
export function usePtyBuffer(agentId: string): readonly string[] {
  return useTerminalStore((state) => state.ptyBuffers[agentId] ?? []);
}

/** Select whether terminal mode is active for a specific agent. */
export function useTerminalActive(agentId: string): boolean {
  return useTerminalStore((state) => state.terminalActive[agentId] ?? false);
}
