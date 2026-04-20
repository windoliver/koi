import type { NmControlFrame } from "../../src/native-host/control-frames.js";

export interface KeepaliveController {
  readonly installAlarm: () => Promise<void>;
  readonly handleAlarm: (alarm: chrome.alarms.Alarm) => Promise<void>;
  readonly startPortPing: () => void;
  readonly stopPortPing: () => void;
}

export function createKeepalive(deps: {
  readonly ensureConnected: () => Promise<void>;
  readonly sendControlFrame: (frame: Extract<NmControlFrame, { kind: "ping" }>) => void;
  readonly alarmName?: string;
  readonly pingIntervalMs?: number;
}): KeepaliveController {
  const alarmName = deps.alarmName ?? "koi-keepalive";
  const pingIntervalMs = deps.pingIntervalMs ?? 5_000;
  let pingTimer: ReturnType<typeof setInterval> | null = null;

  return {
    async installAlarm(): Promise<void> {
      await (
        chrome.alarms.create as unknown as (
          name: string,
          details: chrome.alarms.AlarmCreateInfo,
        ) => Promise<void>
      )(alarmName, { periodInMinutes: 0.5 });
    },
    async handleAlarm(alarm): Promise<void> {
      if (alarm.name !== alarmName) return;
      await deps.ensureConnected();
      await (
        chrome.storage.session.set as unknown as (items: Record<string, unknown>) => Promise<void>
      )({
        "koi.keepaliveTouchedAt": Date.now(),
      });
    },
    startPortPing(): void {
      if (pingTimer !== null) return;
      pingTimer = setInterval(() => {
        deps.sendControlFrame({ kind: "ping", seq: Date.now() });
      }, pingIntervalMs);
    },
    stopPortPing(): void {
      if (pingTimer === null) return;
      clearInterval(pingTimer);
      pingTimer = null;
    },
  };
}
