/**
 * BgView — full-screen `/bg` background-session registry view (#1944).
 *
 * Layout:
 *   1. Banner   — registry stale/degraded warning (hidden when live)
 *   2. Row table — cursor-selectable list of BgSessionRow
 *   3. Footer hint — context-sensitive key hint line
 *   4. Kill confirm modal — overlaid when bg.killConfirm !== null
 *
 * Key handlers: Enter (tail logs), k (kill), Esc (back / stop tailing).
 * All state mutations go through dispatch; no direct I/O.
 */

import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import { For, Show, createMemo, createSignal, type Component, useContext } from "solid-js";
import type { BgSessionRow, BgSessionsSlice, RegistryStatus } from "../state/types.js";
import { StoreContext } from "../store-context.js";
import { COLORS } from "../theme.js";
import { BgLogTail } from "./BgLogTail.js";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const COL_FRESH = 14;
const COL_WORKER = 22;
const COL_AGENT = 20;
const COL_STATUS = 14;
const COL_PID = 8;
const COL_AGE = 12;
const MAX_LOG_PATH = 28;

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/** Returns true when the row can be killed via supervisor.stop() on-path. */
export function isKillEligible(row: BgSessionRow): boolean {
  const eligible = new Set<BgSessionRow["freshness"]>([
    "ok",
    "pending",
    "stale",
    "timeout",
    "unmonitored",
    "restarting",
    "quarantined",
    "stopping",
  ]);
  return eligible.has(row.freshness);
}

/** Maps a freshness value to a display color from COLORS. */
export function freshnessColor(
  freshness: BgSessionRow["freshness"],
  colors: typeof COLORS,
): string {
  switch (freshness) {
    case "ok":
      return colors.success;
    case "stale":
    case "restarting":
    case "stopping":
    case "terminating":
      return colors.amber;
    case "timeout":
    case "quarantined":
      return colors.danger;
    case "detached":
      return colors.blue;
    case "pending":
    case "unmonitored":
    case "foreign":
    case "terminal":
      return colors.textMuted;
  }
}

/** Human-readable age string for a timestamp delta. */
function ageString(startedAt: number, now: number): string {
  const diffMs = now - startedAt;
  if (diffMs >= 3_600_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
  if (diffMs >= 60_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs >= 1000) return `${Math.floor(diffMs / 1000)}s ago`;
  return `${diffMs}ms ago`;
}

/** Abbreviate a log path for display — keep last MAX_LOG_PATH chars. */
function abbreviateLogPath(logPath: string): string {
  if (logPath === "") return "(none)";
  if (logPath.length <= MAX_LOG_PATH) return logPath;
  return `…${logPath.slice(-(MAX_LOG_PATH - 1))}`;
}

/** Format a single BgSessionRow for table display. */
export function formatBgRow(
  row: BgSessionRow,
  now: number,
): {
  readonly freshness: string;
  readonly workerId: string;
  readonly agentId: string;
  readonly status: string;
  readonly pid: string;
  readonly age: string;
  readonly logPath: string;
} {
  return {
    freshness: row.freshness,
    workerId: row.workerId,
    agentId: row.agentId,
    status: row.status,
    pid: String(row.pid),
    age: ageString(row.startedAt, now),
    logPath: abbreviateLogPath(row.logPath),
  };
}

/** Returns a banner object for non-live registry status, or null when live. */
export function formatRegistryBanner(
  status: RegistryStatus,
  now: number,
): { readonly color: string; readonly text: string } | null {
  if (status.kind === "live") return null;
  if (status.kind === "degraded") {
    const secs = Math.round((now - status.since) / 1000);
    return {
      color: COLORS.amber,
      text: `Registry events down (${secs}s) — rows may lag, polls live`,
    };
  }
  // stale
  const secs = Math.round((now - status.since) / 1000);
  return {
    color: COLORS.red,
    text: `Registry unreadable: ${status.reason} (${secs}s) — preserved last snapshot`,
  };
}

/** Returns the footer hint line for the given row + tailing state. */
export function killHintFor(row: BgSessionRow, isTailing: boolean): string {
  if (isTailing) return "[Esc] stop tailing";
  if (row.freshness === "terminal") return "[Enter] tail logs · k disabled (already terminal) · [Esc] back";
  if (row.freshness === "foreign") {
    return "[Enter] tail logs (read-only) · k disabled (foreign — use `koi bg kill`) · [Esc] back";
  }
  if (row.logPath === "") return "[Enter] disabled (logging disabled) · [Esc] back";
  if (isKillEligible(row)) return "[Enter] tail logs · [k] kill · [Esc] back";
  return "[Enter] tail logs · [Esc] back";
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function pad(s: string, w: number): string {
  if (s.length >= w) return `${s.slice(0, Math.max(0, w - 1))} `;
  return s + " ".repeat(w - s.length);
}

const TableHeader: Component = () => (
  <text fg={COLORS.textMuted}>
    {pad("freshness", COL_FRESH) +
      pad("workerId", COL_WORKER) +
      pad("agentId", COL_AGENT) +
      pad("status", COL_STATUS) +
      pad("pid", COL_PID) +
      pad("age", COL_AGE) +
      "logPath"}
  </text>
);

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface BgViewProps {
  readonly slice: BgSessionsSlice;
  /** Route an action to the CLI host (mirrors McpView pattern). */
  readonly onCommand: (commandId: string, args: string) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const BgView: Component<BgViewProps> = (props) => {
  const store = useContext(StoreContext);
  const [cursor, setCursor] = createSignal(0);
  const now = (): number => Date.now();

  const dispatch = (action: Parameters<NonNullable<typeof store>["dispatch"]>[0]): void => {
    store?.dispatch(action);
  };

  const rows = (): readonly BgSessionRow[] => props.slice.rows;
  const selectedRow = (): BgSessionRow | undefined => rows()[cursor()];

  const tailingRow = createMemo((): BgSessionRow | null => {
    const id = props.slice.tailingWorkerId;
    if (id === null) return null;
    return rows().find((r) => r.workerId === id) ?? null;
  });

  const banner = (): { readonly color: string; readonly text: string } | null =>
    formatRegistryBanner(props.slice.registryStatus, now());

  const isTailing = (): boolean => props.slice.tailingWorkerId !== null;

  const hintText = (): string => {
    if (isTailing()) return "[Esc] stop tailing";
    const row = selectedRow();
    if (row === undefined) return "[Esc] back";
    return killHintFor(row, false);
  };

  const confirmRow = (): BgSessionRow | undefined => {
    const c = props.slice.killConfirm;
    if (c === null) return undefined;
    return rows().find((r) => r.workerId === c.workerId);
  };

  useKeyboard((key: KeyEvent) => {
    if (props.slice.killConfirm !== null) {
      // Modal is open — only handle modal keys
      if (key.name === "y") {
        key.preventDefault();
        const confirm = props.slice.killConfirm;
        if (confirm !== null) {
          const row = rows().find((r) => r.workerId === confirm.workerId);
          if (row !== undefined) {
            props.onCommand(
              "system:bg-kill",
              JSON.stringify({
                workerId: confirm.workerId,
                expectedVersion: confirm.version,
                expectedPid: confirm.pid,
              }),
            );
          }
          dispatch({ kind: "set_bg_kill_confirm", confirm: null });
        }
        return;
      }
      if (key.name === "n" || key.name === "escape") {
        key.preventDefault();
        dispatch({ kind: "set_bg_kill_confirm", confirm: null });
        return;
      }
      return; // Focus-trap: ignore all other keys when modal open
    }

    if (key.name === "up" || (key.ctrl && key.name === "p")) {
      key.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.name === "down" || (key.ctrl && key.name === "n")) {
      key.preventDefault();
      setCursor((c) => Math.min(rows().length - 1, c + 1));
      return;
    }
    if (key.name === "escape") {
      key.preventDefault();
      if (isTailing()) {
        dispatch({ kind: "set_bg_tailing", workerId: null });
      } else {
        props.onCommand("system:nav-back", "");
      }
      return;
    }
    if (key.name === "return") {
      key.preventDefault();
      const row = selectedRow();
      if (row === undefined) return;
      // Allow tailing for any row with a logPath, including terminal rows —
      // operators most need post-crash/exit log access. Only `k` (kill) is
      // gated by row state.
      if (row.logPath !== "") {
        dispatch({ kind: "set_bg_tailing", workerId: row.workerId });
      }
      return;
    }
    if (key.name === "k") {
      key.preventDefault();
      const row = selectedRow();
      if (row === undefined) return;
      if (!isKillEligible(row)) return;
      dispatch({
        kind: "set_bg_kill_confirm",
        confirm: { workerId: row.workerId, version: row.version, pid: row.pid },
      });
      return;
    }
  });

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={2} paddingRight={2} paddingTop={1}>
      <text fg={COLORS.accent}>{"Background Sessions"}</text>

      {/* Registry status banner */}
      <Show when={banner()}>
        {(b: () => { readonly color: string; readonly text: string }) => (
          <text fg={b().color}>{b().text}</text>
        )}
      </Show>

      {/* Log tail — shown when a worker is selected for tailing */}
      <Show when={tailingRow()}>
        {(rowAccessor: () => BgSessionRow) => <BgLogTail row={rowAccessor()} />}
      </Show>

      {/* Row table */}
      <Show
        when={rows().length > 0}
        fallback={
          <box paddingTop={1}>
            <text fg={COLORS.textMuted}>{"No background sessions found."}</text>
          </box>
        }
      >
        <box flexDirection="column" paddingTop={1}>
          <TableHeader />
          <For each={rows()}>
            {(row: BgSessionRow, idx: () => number) => {
              const formatted = formatBgRow(row, Date.now());
              const isSelected = (): boolean => idx() === cursor();
              const fgColor = freshnessColor(row.freshness, COLORS);
              const line =
                pad(formatted.freshness, COL_FRESH) +
                pad(formatted.workerId, COL_WORKER) +
                pad(formatted.agentId, COL_AGENT) +
                pad(formatted.status, COL_STATUS) +
                pad(formatted.pid, COL_PID) +
                pad(formatted.age, COL_AGE) +
                formatted.logPath;
              return (
                <Show
                  when={isSelected()}
                  fallback={<text fg={fgColor}>{`  ${line}`}</text>}
                >
                  <box backgroundColor={COLORS.bgHover}>
                    <text fg={COLORS.white}>{`▶ ${line}`}</text>
                  </box>
                </Show>
              );
            }}
          </For>
        </box>
      </Show>

      {/* Footer hint */}
      <box paddingTop={1}>
        <text fg={COLORS.textMuted}>{hintText()}</text>
      </box>

      {/* Kill confirm modal */}
      <Show when={props.slice.killConfirm !== null}>
        <KillConfirmModal
          confirm={props.slice.killConfirm}
          row={confirmRow()}
        />
      </Show>
    </box>
  );
};

// ---------------------------------------------------------------------------
// Kill confirm modal sub-component
// ---------------------------------------------------------------------------

interface KillConfirmModalProps {
  readonly confirm: BgSessionsSlice["killConfirm"];
  readonly row: BgSessionRow | undefined;
}

const KillConfirmModal: Component<KillConfirmModalProps> = (p) => {
  const c = p.confirm;
  if (c === null) return null;

  return (
    <box
      position="absolute"
      top={3}
      left={4}
      zIndex={30}
      backgroundColor={COLORS.bgElevated}
      flexDirection="column"
      border={true}
      borderColor={COLORS.amber}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      paddingBottom={1}
    >
      <text fg={COLORS.white}>
        <b>{`Kill worker ${c.workerId}?`}</b>
      </text>
      <Show when={p.row !== undefined}>
        <box flexDirection="column" paddingTop={1}>
          <text fg={COLORS.textSecondary}>{`  agent:  ${p.row?.agentId ?? "—"}`}</text>
          <text fg={COLORS.textSecondary}>{`  pid:    ${c.pid}`}</text>
          <text fg={COLORS.textSecondary}>{`  status: ${p.row?.status ?? "—"}`}</text>
        </box>
      </Show>
      <box flexDirection="row" paddingTop={1} gap={2}>
        <text fg={COLORS.success}>{"[y]es"}</text>
        <text fg={COLORS.danger}>{"[n]o / Esc"}</text>
      </box>
    </box>
  );
};
