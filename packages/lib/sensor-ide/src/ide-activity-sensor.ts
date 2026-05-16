import type { SignalSource, UserSignal } from "@koi/core";

export type IdeDiagnosticSeverity = "error" | "warning" | "info";

export type IdeActivityEvent =
  | {
      readonly kind: "edit";
      readonly filePath: string;
      readonly timestamp: number;
      readonly insertedChars?: number | undefined;
      readonly deletedChars?: number | undefined;
    }
  | {
      readonly kind: "diagnostic";
      readonly filePath: string;
      readonly timestamp: number;
      readonly severity: IdeDiagnosticSeverity;
      readonly count: number;
    }
  | {
      readonly kind: "file_focus";
      readonly filePath: string;
      readonly timestamp: number;
    }
  | {
      readonly kind: "delete";
      readonly filePath: string;
      readonly timestamp: number;
      readonly chars?: number | undefined;
    }
  | {
      readonly kind: "undo";
      readonly filePath: string;
      readonly timestamp: number;
    };

export interface IdeActivitySummaryEvent {
  readonly kind: IdeActivityEvent["kind"];
  readonly filePath: string;
  readonly timestamp: number;
}

export interface IdeActivitySnapshot {
  readonly [key: string]: unknown;
  readonly typingSpeedCharsPerMinute: number;
  readonly errorCount: number;
  readonly errorRatePerFile: number;
  readonly fileSwitchesPerMinute: number;
  readonly flowState: boolean;
  readonly contextSwitchDetected: boolean;
  readonly frustrationDetected: boolean;
  readonly recentEvents: readonly IdeActivitySummaryEvent[];
  readonly activeFileCount: number;
  readonly sampledAt: number;
  readonly windowMs: number;
}

export interface IdeActivitySensorConfig {
  readonly name?: string | undefined;
  readonly source?: string | undefined;
  readonly now?: (() => number) | undefined;
  readonly windowMs?: number | undefined;
  readonly maxEvents?: number | undefined;
  readonly flowWindowMs?: number | undefined;
  readonly minFlowEditEvents?: number | undefined;
  readonly minFlowDurationMs?: number | undefined;
  readonly maxFlowFiles?: number | undefined;
  readonly contextSwitchWindowMs?: number | undefined;
  readonly contextSwitchThreshold?: number | undefined;
  readonly frustrationWindowMs?: number | undefined;
  readonly frustrationThreshold?: number | undefined;
}

export interface IdeActivitySensor extends SignalSource {
  readonly record: (event: IdeActivityEvent) => void;
  readonly subscribe: (handler: (event: IdeActivityEvent) => void) => () => void;
  readonly snapshot: () => IdeActivitySnapshot;
  readonly clear: () => void;
}

interface ResolvedConfig {
  readonly name: string;
  readonly source: string;
  readonly now: () => number;
  readonly windowMs: number;
  readonly maxEvents: number;
  readonly flowWindowMs: number;
  readonly minFlowEditEvents: number;
  readonly minFlowDurationMs: number;
  readonly maxFlowFiles: number;
  readonly contextSwitchWindowMs: number;
  readonly contextSwitchThreshold: number;
  readonly frustrationWindowMs: number;
  readonly frustrationThreshold: number;
}

const DEFAULT_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_MAX_EVENTS = 512;
const DEFAULT_FLOW_WINDOW_MS = 2 * 60 * 1000;
const DEFAULT_MIN_FLOW_EDIT_EVENTS = 6;
const DEFAULT_MIN_FLOW_DURATION_MS = 60 * 1000;
const DEFAULT_MAX_FLOW_FILES = 1;
const DEFAULT_CONTEXT_SWITCH_WINDOW_MS = 60 * 1000;
const DEFAULT_CONTEXT_SWITCH_THRESHOLD = 4;
const DEFAULT_FRUSTRATION_WINDOW_MS = 60 * 1000;
const DEFAULT_FRUSTRATION_THRESHOLD = 5;

function finiteNonNegative(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return 0;
  return value;
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function resolveConfig(config: IdeActivitySensorConfig): ResolvedConfig {
  return {
    name: config.name ?? "ide",
    source: config.source ?? "ide",
    now: config.now ?? Date.now,
    windowMs: positiveInt(config.windowMs, DEFAULT_WINDOW_MS),
    maxEvents: positiveInt(config.maxEvents, DEFAULT_MAX_EVENTS),
    flowWindowMs: positiveInt(config.flowWindowMs, DEFAULT_FLOW_WINDOW_MS),
    minFlowEditEvents: positiveInt(config.minFlowEditEvents, DEFAULT_MIN_FLOW_EDIT_EVENTS),
    minFlowDurationMs: positiveInt(config.minFlowDurationMs, DEFAULT_MIN_FLOW_DURATION_MS),
    maxFlowFiles: positiveInt(config.maxFlowFiles, DEFAULT_MAX_FLOW_FILES),
    contextSwitchWindowMs: positiveInt(
      config.contextSwitchWindowMs,
      DEFAULT_CONTEXT_SWITCH_WINDOW_MS,
    ),
    contextSwitchThreshold: positiveInt(
      config.contextSwitchThreshold,
      DEFAULT_CONTEXT_SWITCH_THRESHOLD,
    ),
    frustrationWindowMs: positiveInt(config.frustrationWindowMs, DEFAULT_FRUSTRATION_WINDOW_MS),
    frustrationThreshold: positiveInt(config.frustrationThreshold, DEFAULT_FRUSTRATION_THRESHOLD),
  };
}

function isValidEvent(event: IdeActivityEvent): boolean {
  return (
    Number.isFinite(event.timestamp) &&
    event.timestamp >= 0 &&
    typeof event.filePath === "string" &&
    event.filePath.length > 0
  );
}

function cloneEvent(event: IdeActivityEvent): IdeActivityEvent {
  return { ...event } as IdeActivityEvent;
}

function prune(events: IdeActivityEvent[], cfg: ResolvedConfig, now: number): void {
  const cutoff = now - cfg.windowMs;
  while (events.length > 0 && (events[0]?.timestamp ?? 0) < cutoff) {
    events.shift();
  }
  while (events.length > cfg.maxEvents) {
    events.shift();
  }
}

function eventsInWindow<T extends IdeActivityEvent>(
  events: readonly IdeActivityEvent[],
  now: number,
  windowMs: number,
  predicate: (event: IdeActivityEvent) => event is T,
): T[] {
  const cutoff = now - windowMs;
  return events.filter(
    (event): event is T => event.timestamp >= cutoff && event.timestamp <= now && predicate(event),
  );
}

function visibleEvents(
  events: readonly IdeActivityEvent[],
  now: number,
): readonly IdeActivityEvent[] {
  return events.filter((event) => event.timestamp <= now);
}

function isEdit(event: IdeActivityEvent): event is Extract<IdeActivityEvent, { kind: "edit" }> {
  return event.kind === "edit";
}

function isFocus(
  event: IdeActivityEvent,
): event is Extract<IdeActivityEvent, { kind: "file_focus" }> {
  return event.kind === "file_focus";
}

function isCorrectionBurstEvent(
  event: IdeActivityEvent,
): event is Extract<IdeActivityEvent, { kind: "delete" | "undo" }> {
  return event.kind === "delete" || event.kind === "undo";
}

function roundMetric(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

function countFileSwitches(
  focusEvents: readonly Extract<IdeActivityEvent, { kind: "file_focus" }>[],
): number {
  let switches = 0;
  let previous: string | undefined;
  for (const event of focusEvents) {
    if (previous !== undefined && event.filePath !== previous) switches += 1;
    previous = event.filePath;
  }
  return switches;
}

function perMinute(count: number, events: readonly IdeActivityEvent[]): number {
  if (events.length < 2) return 0;
  const first = events[0]?.timestamp ?? 0;
  const last = events[events.length - 1]?.timestamp ?? first;
  const minutes = (last - first) / 60_000;
  if (minutes <= 0) return 0;
  return roundMetric(count / minutes);
}

function typingSpeed(editEvents: readonly Extract<IdeActivityEvent, { kind: "edit" }>[]): number {
  const inserted = editEvents.reduce(
    (sum, event) => sum + finiteNonNegative(event.insertedChars),
    0,
  );
  return perMinute(inserted, editEvents);
}

function eventSpanMs(events: readonly IdeActivityEvent[]): number {
  if (events.length < 2) return 0;
  const first = events[0]?.timestamp ?? 0;
  const last = events[events.length - 1]?.timestamp ?? first;
  return Math.max(0, last - first);
}

function latestErrorCounts(events: readonly IdeActivityEvent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.kind !== "diagnostic" || event.severity !== "error") continue;
    counts.set(event.filePath, finiteNonNegative(event.count));
  }
  return counts;
}

function recentEvents(events: readonly IdeActivityEvent[]): readonly IdeActivitySummaryEvent[] {
  return events.map((event) => ({
    kind: event.kind,
    filePath: event.filePath,
    timestamp: event.timestamp,
  }));
}

export function createIdeActivitySensor(config: IdeActivitySensorConfig = {}): IdeActivitySensor {
  const cfg = resolveConfig(config);
  const events: IdeActivityEvent[] = [];
  const subscribers = new Set<(event: IdeActivityEvent) => void>();

  function emit(event: IdeActivityEvent): void {
    for (const subscriber of subscribers) {
      try {
        subscriber({ ...event } as IdeActivityEvent);
      } catch {
        // Consumer failures must not interrupt IDE event ingestion.
      }
    }
  }

  function snapshot(): IdeActivitySnapshot {
    const now = cfg.now();
    prune(events, cfg, now);
    const visible = visibleEvents(events, now);

    const editEvents = eventsInWindow(visible, now, cfg.windowMs, isEdit);
    const focusEvents = eventsInWindow(visible, now, cfg.windowMs, isFocus);
    const flowEvents = eventsInWindow(visible, now, cfg.flowWindowMs, isEdit);
    const contextEvents = eventsInWindow(visible, now, cfg.contextSwitchWindowMs, isFocus);
    const frustrationEvents = eventsInWindow(
      visible,
      now,
      cfg.frustrationWindowMs,
      isCorrectionBurstEvent,
    );
    const errorCounts = latestErrorCounts(visible);
    const errorCount = [...errorCounts.values()].reduce((sum, count) => sum + count, 0);
    const flowFiles = new Set(flowEvents.map((event) => event.filePath));
    const contextSwitches = countFileSwitches(contextEvents);

    return {
      typingSpeedCharsPerMinute: typingSpeed(editEvents),
      errorCount,
      errorRatePerFile: roundMetric(errorCount / Math.max(1, errorCounts.size)),
      fileSwitchesPerMinute: perMinute(countFileSwitches(focusEvents), focusEvents),
      flowState:
        flowEvents.length >= cfg.minFlowEditEvents &&
        eventSpanMs(flowEvents) >= cfg.minFlowDurationMs &&
        flowFiles.size > 0 &&
        flowFiles.size <= cfg.maxFlowFiles,
      contextSwitchDetected: contextSwitches >= cfg.contextSwitchThreshold,
      frustrationDetected: frustrationEvents.length >= cfg.frustrationThreshold,
      recentEvents: recentEvents(visible),
      activeFileCount: new Set(visible.map((event) => event.filePath)).size,
      sampledAt: now,
      windowMs: cfg.windowMs,
    };
  }

  return {
    name: cfg.name,
    record(event) {
      if (!isValidEvent(event)) return;
      const retained = cloneEvent(event);
      events.push(retained);
      events.sort((a, b) => a.timestamp - b.timestamp);
      prune(events, cfg, cfg.now());
      emit(retained);
    },
    subscribe(handler) {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },
    snapshot,
    read(): UserSignal {
      return {
        kind: "sensor",
        source: cfg.source,
        values: snapshot(),
      };
    },
    clear() {
      events.length = 0;
    },
  };
}
