/**
 * ToastOverlay — top-right transient notification overlay (gov-9).
 *
 * The TUI store enforces fold-merge by key + cap at MAX_VISIBLE_TOASTS;
 * this component renders the slice as-is. Each row mounts an auto-dismiss
 * timer that fires onDismiss(id) after autoDismissMs (default 8s).
 *
 * Read-only — never mutates governance state.
 */

import { For, onCleanup, onMount, type Component } from "solid-js";
import type { Toast, ToastKind } from "../state/types.js";
import { COLORS } from "../theme.js";

const DEFAULT_AUTO_DISMISS_MS = 8000;

const TOAST_COLOR: Record<ToastKind, string> = {
  info: COLORS.blueAccent,
  warn: COLORS.amber,
  error: COLORS.danger,
};

const TOAST_GLYPH: Record<ToastKind, string> = {
  info: "ⓘ",
  warn: "⚠",
  error: "✗",
};

export interface ToastOverlayProps {
  readonly toasts: readonly Toast[];
  readonly onDismiss: (id: string) => void;
}

export const ToastOverlay: Component<ToastOverlayProps> = (props) => {
  return (
    <box
      position="absolute"
      top={0}
      right={2}
      flexDirection="column"
      zIndex={100}
    >
      <For each={props.toasts}>
        {(toast) => <ToastRow toast={toast} onDismiss={props.onDismiss} />}
      </For>
    </box>
  );
};

interface ToastRowProps {
  readonly toast: Toast;
  readonly onDismiss: (id: string) => void;
}

const ToastRow: Component<ToastRowProps> = (props) => {
  onMount(() => {
    const ms = props.toast.autoDismissMs ?? DEFAULT_AUTO_DISMISS_MS;
    const timer = setTimeout(() => props.onDismiss(props.toast.id), ms);
    onCleanup(() => clearTimeout(timer));
  });

  const color = TOAST_COLOR[props.toast.kind];
  const glyph = TOAST_GLYPH[props.toast.kind];

  return (
    <box
      flexDirection="column"
      borderStyle="rounded"
      borderColor={color}
      paddingX={1}
      marginBottom={1}
    >
      <text fg={color}>
        {glyph} {props.toast.title}
      </text>
      <text fg={COLORS.textMuted}>{props.toast.body}</text>
    </box>
  );
};
