/**
 * Governance bridge — wires @koi/governance-core callbacks + controller into
 * the TUI store. Mirror of cost-bridge.ts.
 *
 * Persists alerts to JSONL (last 200) so the /governance view can show recent
 * history across sessions.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  GovernanceController,
  GovernanceSnapshot,
  RuleDescriptor,
  SensorReading,
} from "@koi/core";
import type { CapabilityFragmentLite, GovernanceAlert, TuiStore } from "@koi/tui";

const MAX_PERSISTED_ALERTS = 200;

export interface GovernanceBridgeConfig {
  readonly store: TuiStore;
  readonly controller: GovernanceController;
  readonly sessionId: string;
  /** Absolute path to JSONL alerts file. */
  readonly alertsPath: string;
  /** Optional initial rules to push at startup. */
  readonly rules?: readonly RuleDescriptor[] | undefined;
  /** Optional initial capabilities to push at startup. */
  readonly capabilities?: readonly CapabilityFragmentLite[] | undefined;
}

export interface GovernanceBridge {
  /** Subscribe target for governance-core's `onAlert` callback. */
  readonly recordAlert: (pct: number, variable: string, reading: SensorReading) => void;
  /** Subscribe target for governance-core's `onViolation` callback. */
  readonly recordViolation: (variable: string, reason: string) => void;
  /** Push a fresh snapshot into the store (call after every engine done). */
  readonly pollSnapshot: () => void;
  /** Load up to N most recent persisted alerts from disk. */
  readonly loadRecentAlerts: (n: number) => readonly GovernanceAlert[];
  /** Update session id (call on session reset). */
  readonly setSession: (sessionId: string) => void;
  /** Stop any timers / release resources. */
  readonly dispose: () => void;
}

export function createGovernanceBridge(config: GovernanceBridgeConfig): GovernanceBridge {
  // let: justified — mutated by setSession
  let sessionId = config.sessionId;

  ensureParentDir(config.alertsPath);

  if (config.rules !== undefined) {
    config.store.dispatch({ kind: "set_governance_rules", rules: config.rules });
  }
  if (config.capabilities !== undefined) {
    config.store.dispatch({
      kind: "set_governance_capabilities",
      capabilities: config.capabilities,
    });
  }

  function nextId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function persistAlert(a: GovernanceAlert): void {
    try {
      appendFileSync(config.alertsPath, `${JSON.stringify(a)}\n`, "utf8");
      tailEvict(config.alertsPath, MAX_PERSISTED_ALERTS);
    } catch (err: unknown) {
      console.warn("[governance-bridge] alert persist failed:", err);
    }
  }

  return {
    recordAlert(pct: number, variable: string, reading: SensorReading): void {
      const alert: GovernanceAlert = {
        id: nextId(),
        ts: Date.now(),
        sessionId,
        variable,
        threshold: pct,
        current: reading.current,
        limit: reading.limit,
        utilization: reading.utilization,
      };
      config.store.dispatch({ kind: "add_governance_alert", alert });
      persistAlert(alert);
    },

    recordViolation(variable: string, reason: string): void {
      config.store.dispatch({
        kind: "add_governance_violation",
        violation: { id: nextId(), ts: Date.now(), variable, reason },
      });
    },

    pollSnapshot(): void {
      const result = config.controller.snapshot();
      if (result instanceof Promise) {
        void result
          .then((snap: GovernanceSnapshot) => {
            config.store.dispatch({ kind: "set_governance_snapshot", snapshot: snap });
          })
          .catch((err: unknown) => {
            console.warn("[governance-bridge] snapshot poll failed:", err);
          });
      } else {
        config.store.dispatch({ kind: "set_governance_snapshot", snapshot: result });
      }
    },

    loadRecentAlerts(n: number): readonly GovernanceAlert[] {
      if (!existsSync(config.alertsPath)) return [];
      try {
        const raw = readFileSync(config.alertsPath, "utf8");
        const lines = raw.split("\n").filter((l) => l.length > 0);
        const slice = lines.slice(-n);
        return slice.map((l) => JSON.parse(l) as GovernanceAlert);
      } catch (err: unknown) {
        console.warn("[governance-bridge] alert load failed:", err);
        return [];
      }
    },

    setSession(newSessionId: string): void {
      sessionId = newSessionId;
    },

    dispose(): void {
      // No timers, no open handles — appendFileSync is synchronous.
    },
  };
}

function ensureParentDir(path: string): void {
  // mkdirSync({ recursive: true }) is idempotent for EEXIST; real failures
  // (EACCES, ENOTDIR) propagate at bridge construction time so callers see them.
  mkdirSync(dirname(path), { recursive: true });
}

function tailEvict(path: string, maxLines: number): void {
  try {
    const raw = readFileSync(path, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    if (lines.length <= maxLines) return;
    const trimmed = `${lines.slice(-maxLines).join("\n")}\n`;
    writeFileSync(path, trimmed, "utf8");
  } catch (err: unknown) {
    console.warn("[governance-bridge] tail-evict failed:", err);
  }
}
