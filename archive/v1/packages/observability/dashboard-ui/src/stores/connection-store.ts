/**
 * Zustand store for SSE connection state.
 */

import { create } from "zustand";
import type { SseConnectionState } from "../lib/sse-client.js";

interface ConnectionState {
  readonly status: SseConnectionState;
  readonly setStatus: (status: SseConnectionState) => void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  status: "disconnected",
  setStatus: (status) => set({ status }),
}));
